/**
 * @jest-environment node
 *
 * Tests for the canonical stats derivation algorithm in `@/lib/stats`. These
 * exercise representative datasets (multiple runs, boundary runs, gaps, low
 * pressure spells, multi-device, custom thresholds) and lock in the exact
 * transition/duration semantics the SQL endpoint mirrors.
 */
import {
  DEFAULT_STATS_THRESHOLDS,
  buildAggregatedStats,
  computeStatsFromRows,
  type StatsRow,
} from '@/lib/stats'

// One row per "minute". A pump-on row carries running current; off rows are idle.
// Pressure stays normal unless explicitly set low.
const MINUTE = 60 * 1000
const BASE = Date.parse('2026-01-01T00:00:00.000Z')

function row(minute: number, overrides: Partial<StatsRow> = {}): StatsRow {
  const startTime = BASE + minute * MINUTE
  return {
    timestamp: startTime + MINUTE,
    startTime,
    endTime: startTime + MINUTE, // 60s window
    current1RMS: 0.1, // idle by default
    pressMin: 45, // normal by default
    ...overrides,
  }
}

const ON = { current1RMS: 4.2 }
const LOW = { pressMin: 22 }

describe('computeStatsFromRows', () => {
  it('returns all-zero stats for an empty dataset', () => {
    const stats = computeStatsFromRows([])
    expect(stats).toEqual({
      pumpRunCount: 0,
      pumpDurationSeconds: 0,
      pumpDurationMs: 0,
      lowPressureEventCount: 0,
      lowPressureDurationSeconds: 0,
      lowPressureDurationMs: 0,
      sampleCount: 0,
      averagePumpRunSeconds: 0,
      averageLowPressureSeconds: 0,
    })
  })

  it('counts a single contiguous run once and sums its window spans', () => {
    // 3 consecutive on-minutes = 1 run, 180s total.
    const rows = [row(0, ON), row(1, ON), row(2, ON), row(3) /* off */]
    const stats = computeStatsFromRows(rows)
    expect(stats.pumpRunCount).toBe(1)
    expect(stats.pumpDurationSeconds).toBe(180)
    expect(stats.pumpDurationMs).toBe(180_000)
    expect(stats.averagePumpRunSeconds).toBe(180)
    expect(stats.sampleCount).toBe(4)
  })

  it('counts multiple distinct runs separated by off periods', () => {
    // on,on, off, on, off, on,on,on  => 3 runs; on-minutes = 2+1+3 = 6 => 360s
    const rows = [
      row(0, ON),
      row(1, ON),
      row(2),
      row(3, ON),
      row(4),
      row(5, ON),
      row(6, ON),
      row(7, ON),
    ]
    const stats = computeStatsFromRows(rows)
    expect(stats.pumpRunCount).toBe(3)
    expect(stats.pumpDurationSeconds).toBe(360)
    expect(stats.averagePumpRunSeconds).toBe(120)
  })

  it('counts a run that is active at the very first row (no prior off state)', () => {
    const rows = [row(0, ON), row(1, ON), row(2)]
    const stats = computeStatsFromRows(rows)
    expect(stats.pumpRunCount).toBe(1)
    expect(stats.pumpDurationSeconds).toBe(120)
  })

  it('counts a run still active at the last row (no closing off state)', () => {
    const rows = [row(0), row(1, ON), row(2, ON)]
    const stats = computeStatsFromRows(rows)
    expect(stats.pumpRunCount).toBe(1)
    expect(stats.pumpDurationSeconds).toBe(120)
  })

  it('derives low-pressure events independently of pump runs', () => {
    // Low pressure during minutes 1-2 and again at 5 => 2 events, 3 low-minutes.
    const rows = [row(0), row(1, LOW), row(2, LOW), row(3), row(4), row(5, LOW)]
    const stats = computeStatsFromRows(rows)
    expect(stats.lowPressureEventCount).toBe(2)
    expect(stats.lowPressureDurationSeconds).toBe(180)
    expect(stats.averageLowPressureSeconds).toBe(90)
    // No running current anywhere => no pump activity.
    expect(stats.pumpRunCount).toBe(0)
    expect(stats.pumpDurationSeconds).toBe(0)
  })

  it('handles a row that is simultaneously pump-on and low-pressure', () => {
    const rows = [row(0, { ...ON, ...LOW }), row(1)]
    const stats = computeStatsFromRows(rows)
    expect(stats.pumpRunCount).toBe(1)
    expect(stats.pumpDurationSeconds).toBe(60)
    expect(stats.lowPressureEventCount).toBe(1)
    expect(stats.lowPressureDurationSeconds).toBe(60)
  })

  it('treats values exactly at the threshold as in-state (inclusive bounds)', () => {
    const rows = [
      row(0, {
        current1RMS: DEFAULT_STATS_THRESHOLDS.currentThreshold, // exactly on
        pressMin: DEFAULT_STATS_THRESHOLDS.pressureThreshold, // exactly low
      }),
    ]
    const stats = computeStatsFromRows(rows)
    expect(stats.pumpRunCount).toBe(1)
    expect(stats.lowPressureEventCount).toBe(1)
  })

  it('orders rows chronologically before detecting transitions', () => {
    // Same logical sequence as the multi-run case but shuffled on input.
    const ordered = [row(0, ON), row(1, ON), row(2), row(3, ON)]
    const shuffled = [ordered[2], ordered[0], ordered[3], ordered[1]]
    const stats = computeStatsFromRows(shuffled)
    expect(stats.pumpRunCount).toBe(2)
    expect(stats.pumpDurationSeconds).toBe(180)
  })

  it('detects transitions per-device so interleaved devices do not merge', () => {
    // Device A: on,on (1 run). Device B: on, off, on (2 runs). Interleaved.
    const rows = [
      row(0, { ...ON, device: 'A' }),
      row(0, { ...ON, device: 'B' }),
      row(1, { ...ON, device: 'A' }),
      row(1, { device: 'B' }), // B off
      row(2, { device: 'A' }), // A off
      row(2, { ...ON, device: 'B' }),
    ]
    const stats = computeStatsFromRows(rows)
    expect(stats.pumpRunCount).toBe(3) // A:1 + B:2
    // A on-minutes: 2; B on-minutes: 2 => 4 * 60 = 240s
    expect(stats.pumpDurationSeconds).toBe(240)
  })

  it('respects custom thresholds', () => {
    // With a high current threshold, a modest current no longer counts as on.
    const rows = [row(0, { current1RMS: 1.0 }), row(1, { current1RMS: 1.0 })]
    const strict = computeStatsFromRows(rows, {
      currentThreshold: 2.0,
      pressureThreshold: 30,
    })
    expect(strict.pumpRunCount).toBe(0)

    const lenient = computeStatsFromRows(rows, {
      currentThreshold: 0.5,
      pressureThreshold: 30,
    })
    expect(lenient.pumpRunCount).toBe(1)
  })

  it('ignores non-positive window spans (clock skew / zero-length windows)', () => {
    const rows = [
      row(0, { ...ON, startTime: BASE, endTime: BASE }), // zero-length
      row(1, { ...ON, startTime: BASE + 2 * MINUTE, endTime: BASE + MINUTE }), // negative
    ]
    const stats = computeStatsFromRows(rows)
    expect(stats.pumpRunCount).toBe(1) // still one contiguous run
    expect(stats.pumpDurationSeconds).toBe(0) // but no positive duration accrued
  })

  it('aggregates a realistic day: ~24 short runs + steady normal pressure', () => {
    const rows: StatsRow[] = []
    // 1440 minutes; pump runs for 1 minute at the top of each hour (24 runs).
    for (let m = 0; m < 1440; m++) {
      const isOn = m % 60 === 0
      rows.push(row(m, isOn ? ON : {}))
    }
    const stats = computeStatsFromRows(rows)
    expect(stats.sampleCount).toBe(1440)
    expect(stats.pumpRunCount).toBe(24)
    expect(stats.pumpDurationSeconds).toBe(24 * 60)
    expect(stats.averagePumpRunSeconds).toBe(60)
  })
})

describe('buildAggregatedStats', () => {
  it('derives ms and averages from raw totals', () => {
    const stats = buildAggregatedStats({
      pumpRunCount: 4,
      pumpDurationSeconds: 600,
      lowPressureEventCount: 2,
      lowPressureDurationSeconds: 90,
      sampleCount: 100,
    })
    expect(stats.pumpDurationMs).toBe(600_000)
    expect(stats.lowPressureDurationMs).toBe(90_000)
    expect(stats.averagePumpRunSeconds).toBe(150)
    expect(stats.averageLowPressureSeconds).toBe(45)
  })

  it('reports zero averages when counts are zero (no divide-by-zero)', () => {
    const stats = buildAggregatedStats({
      pumpRunCount: 0,
      pumpDurationSeconds: 0,
      lowPressureEventCount: 0,
      lowPressureDurationSeconds: 0,
      sampleCount: 0,
    })
    expect(stats.averagePumpRunSeconds).toBe(0)
    expect(stats.averageLowPressureSeconds).toBe(0)
  })
})
