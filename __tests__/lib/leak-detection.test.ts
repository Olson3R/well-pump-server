/**
 * @jest-environment node
 *
 * Pure tests for the pressure-drop-rate detector. Exercises the pump-off
 * segment selection, segment-length minimum, latest-row freshness, and the
 * rate threshold itself — calibrated against representative real-world
 * pressure traces (normal overnight drift vs. a leak that cycles the pump
 * every ~2.5h).
 */
import {
  detectContinuousPressureDrop,
  type DetectPressureDropRow,
} from '@/lib/leak-detection'

const MINUTE = 60 * 1000
const BASE = Date.parse('2026-01-01T00:00:00.000Z')

function row(
  minute: number,
  pressMin: number,
  dutyCycle1 = 0,
): DetectPressureDropRow {
  const startTime = new Date(BASE + minute * MINUTE)
  const endTime = new Date(BASE + (minute + 1) * MINUTE)
  return { startTime, endTime, dutyCycle1, pressMin }
}

/** Production defaults: fire at >= 2 PSI/h over a >= 60-minute pump-off segment. */
const T = { maxDropRatePsiPerHour: 2, minSegmentMinutes: 60 }

function linearDecline(length: number, startPsi: number, totalDropPsi: number) {
  const rows: DetectPressureDropRow[] = []
  for (let i = 0; i < length; i++) {
    rows.push(row(i, startPsi - (totalDropPsi * i) / Math.max(1, length - 1)))
  }
  return rows
}

describe('detectContinuousPressureDrop', () => {
  it('returns null with no rows', () => {
    expect(detectContinuousPressureDrop([], T, new Date(BASE))).toBeNull()
  })

  it('fires on a leak-like 7 PSI/h decline across a 2.5h pump-off segment', () => {
    // Mirrors the real-world leak example: pressure 60 → 43 over ~150 min.
    const rows = linearDecline(150, 60, 17)
    const now = new Date(BASE + 150 * MINUTE)
    const result = detectContinuousPressureDrop(rows, T, now)
    expect(result).not.toBeNull()
    expect(result!.dropRatePsiPerHour).toBeGreaterThan(6)
    expect(result!.dropRatePsiPerHour).toBeLessThan(8)
  })

  it('stays silent on normal overnight drift (~0.7 PSI/h with plateaus)', () => {
    // Mirrors normal-usage overnight: 57 → 50 over ~10h, with the back half
    // mostly plateaued. Drop rate averages to ~0.7 PSI/h, well below 2 PSI/h.
    const rows: DetectPressureDropRow[] = []
    // First half: gradual decline 57 → 50 over 5h.
    for (let i = 0; i < 300; i++) {
      rows.push(row(i, 57 - (7 * i) / 299))
    }
    // Second half: flat plateau at 50 for another 5h.
    for (let i = 300; i < 600; i++) {
      rows.push(row(i, 50))
    }
    const now = new Date(BASE + 600 * MINUTE)
    expect(detectContinuousPressureDrop(rows, T, now)).toBeNull()
  })

  it('does not fire when the segment is too short for a stable rate', () => {
    // 6 pump-off rows after a pump cycle — only 6 minutes.
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => row(i, 50, 100)),
      ...Array.from({ length: 6 }, (_, i) => row(5 + i, 50 - i * 1.5)),
    ]
    const now = new Date(BASE + 11 * MINUTE)
    expect(detectContinuousPressureDrop(rows, T, now)).toBeNull()
  })

  it('only evaluates the segment AFTER the most recent pump cycle', () => {
    // Long earlier decline, then a pump cycle, then a short pump-off tail.
    const rows = [
      ...linearDecline(120, 60, 17), // big drop before cycle (would alert)
      row(120, 60, 100), // pump cycles
      ...Array.from({ length: 10 }, (_, i) => row(121 + i, 60)),
    ]
    const now = new Date(BASE + 131 * MINUTE)
    // Post-cycle pump-off segment is only ~10 min — below minSegmentMinutes.
    expect(detectContinuousPressureDrop(rows, T, now)).toBeNull()
  })

  it('returns null when the most recent row is stale', () => {
    const rows = linearDecline(150, 60, 17)
    const now = new Date(BASE + 170 * MINUTE) // 20 min beyond last sample
    expect(detectContinuousPressureDrop(rows, T, now)).toBeNull()
  })

  it('returns null when zero thresholds disable the check', () => {
    const rows = linearDecline(150, 60, 17)
    const now = new Date(BASE + 150 * MINUTE)
    expect(
      detectContinuousPressureDrop(rows, { ...T, maxDropRatePsiPerHour: 0 }, now),
    ).toBeNull()
    expect(
      detectContinuousPressureDrop(rows, { ...T, minSegmentMinutes: 0 }, now),
    ).toBeNull()
  })

  it('absorbs a small one-off use within a long quiet segment', () => {
    // 90-minute pump-off segment, mostly flat with one 0.5 PSI dip at min 30.
    // Regression slope absorbs the dip; rate stays well below threshold.
    const rows: DetectPressureDropRow[] = []
    for (let i = 0; i < 90; i++) {
      rows.push(row(i, i === 30 ? 49.5 : 50))
    }
    const now = new Date(BASE + 90 * MINUTE)
    expect(detectContinuousPressureDrop(rows, T, now)).toBeNull()
  })

  it('fires at 3 PSI/h even when the segment is exactly the 60-min minimum', () => {
    // 3 PSI/h * 1h = 3 PSI drop — comfortably above the 2 PSI/h threshold.
    const rows = linearDecline(60, 55, 3)
    const now = new Date(BASE + 60 * MINUTE)
    const result = detectContinuousPressureDrop(rows, T, now)
    expect(result).not.toBeNull()
    expect(result!.dropRatePsiPerHour).toBeGreaterThanOrEqual(2)
  })

  it('rejects a big-drop-then-plateau segment even if the average rate clears the threshold', () => {
    // 4h segment. Pressure leaks 8 PSI in the first hour, then flat for 3h.
    // Overall rate is 2 PSI/h (clears the threshold), but the 3-hour flat
    // tail is a plateau — the leak isn't continuous, so don't alert.
    const rows: DetectPressureDropRow[] = []
    for (let i = 0; i < 60; i++) rows.push(row(i, 60 - (8 * i) / 59))
    for (let i = 60; i < 240; i++) rows.push(row(i, 52))
    const now = new Date(BASE + 240 * MINUTE)
    expect(detectContinuousPressureDrop(rows, T, now)).toBeNull()
  })

  it('rejects a long segment with a sustained plateau in the middle', () => {
    // 3h segment. Drops 60 → 55 over first hour, plateau at 55 for the
    // second hour, then drops 55 → 50 in the third hour. Overall rate
    // would otherwise look like a leak, but the middle plateau means the
    // pressure isn't continuously dropping.
    const rows: DetectPressureDropRow[] = []
    for (let i = 0; i < 60; i++) rows.push(row(i, 60 - (5 * i) / 59))
    for (let i = 60; i < 120; i++) rows.push(row(i, 55))
    for (let i = 120; i < 180; i++) rows.push(row(i, 55 - (5 * (i - 120)) / 59))
    const now = new Date(BASE + 180 * MINUTE)
    expect(detectContinuousPressureDrop(rows, T, now)).toBeNull()
  })

  it('still fires on a continuous decline through a single noisy bucket', () => {
    // 90-min steady leak (4 PSI/h ≈ 6 PSI total), with one 15-min bucket
    // bumped 0.5 PSI higher to mimic sensor jitter. One isolated flat
    // bucket is tolerated — we only reject 2+ consecutive plateaus.
    const rows = linearDecline(90, 55, 6)
    for (let i = 45; i < 60; i++) {
      rows[i] = { ...rows[i], pressMin: rows[i].pressMin + 0.5 }
    }
    const now = new Date(BASE + 90 * MINUTE)
    const result = detectContinuousPressureDrop(rows, T, now)
    expect(result).not.toBeNull()
  })
})
