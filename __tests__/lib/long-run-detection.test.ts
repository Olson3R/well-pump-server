/**
 * @jest-environment node
 *
 * Pure tests for the long-pump-run detector. Exercises the in-memory algorithm
 * directly so the merge-gap, freshness, and accumulation behaviours can be
 * locked in without touching the database.
 */
import {
  detectActiveLongRun,
  type DetectLongRunRow,
} from '@/lib/long-run-detection'

const MINUTE = 60 * 1000
const BASE = Date.parse('2026-01-01T00:00:00.000Z')

function row(minute: number, dutyCycle1 = 100): DetectLongRunRow {
  const startTime = new Date(BASE + minute * MINUTE)
  const endTime = new Date(BASE + (minute + 1) * MINUTE)
  return { startTime, endTime, dutyCycle1 }
}

describe('detectActiveLongRun', () => {
  it('returns null for an empty dataset', () => {
    const now = new Date(BASE + 60 * MINUTE)
    expect(detectActiveLongRun([], now)).toBeNull()
  })

  it('returns null when the pump has never been on', () => {
    const rows = [row(0, 0), row(1, 0), row(2, 0)]
    const now = new Date(BASE + 3 * MINUTE)
    expect(detectActiveLongRun(rows, now)).toBeNull()
  })

  it('returns the active run when the pump has been on contiguously', () => {
    // 70 contiguous on-minutes, latest ending at minute 70.
    const rows = Array.from({ length: 70 }, (_, i) => row(i, 100))
    const now = new Date(BASE + 70 * MINUTE)
    const result = detectActiveLongRun(rows, now)
    expect(result).not.toBeNull()
    expect(result!.runStartMs).toBe(BASE)
    expect(result!.actualOnSeconds).toBeCloseTo(70 * 60, 5)
  })

  it('bridges a single off-minute gap (within merge-gap window)', () => {
    // on, on, off (1 min), on, on — should be one continuous run.
    const rows = [row(0, 100), row(1, 100), row(2, 0), row(3, 100), row(4, 100)]
    const now = new Date(BASE + 5 * MINUTE)
    const result = detectActiveLongRun(rows, now)
    expect(result).not.toBeNull()
    expect(result!.runStartMs).toBe(BASE)
    // 4 on-minutes at full duty.
    expect(result!.actualOnSeconds).toBeCloseTo(4 * 60, 5)
  })

  it('starts a new run after a long off period', () => {
    // First run ends at minute 5; 10 minutes off; second run from minute 15.
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => row(i, 100)),
      ...Array.from({ length: 10 }, (_, i) => row(5 + i, 0)),
      ...Array.from({ length: 3 }, (_, i) => row(15 + i, 100)),
    ]
    const now = new Date(BASE + 18 * MINUTE)
    const result = detectActiveLongRun(rows, now)
    expect(result).not.toBeNull()
    // Current run starts at minute 15, not minute 0.
    expect(result!.runStartMs).toBe(BASE + 15 * MINUTE)
    expect(result!.actualOnSeconds).toBeCloseTo(3 * 60, 5)
  })

  it('returns null when the latest on-sample is stale', () => {
    // Pump was on for 70 minutes but the last on-sample ended 10 minutes ago.
    const rows = Array.from({ length: 70 }, (_, i) => row(i, 100))
    const now = new Date(BASE + 80 * MINUTE) // 10-min gap > 5-min staleness
    expect(detectActiveLongRun(rows, now)).toBeNull()
  })

  it('accumulates partial duty cycles into actualOnSeconds', () => {
    // Three rows at 50% duty over 60s windows = 1.5 minutes total runtime.
    const rows = [row(0, 50), row(1, 50), row(2, 50)]
    const now = new Date(BASE + 3 * MINUTE)
    const result = detectActiveLongRun(rows, now)
    expect(result).not.toBeNull()
    expect(result!.actualOnSeconds).toBeCloseTo(90, 5)
  })

  it('returns null when the pump just turned off', () => {
    // Long on stretch ending with a clear off period beyond the merge gap.
    const rows = [
      ...Array.from({ length: 70 }, (_, i) => row(i, 100)),
      row(70, 0),
      row(71, 0),
      row(72, 0),
    ]
    const now = new Date(BASE + 73 * MINUTE)
    expect(detectActiveLongRun(rows, now)).toBeNull()
  })
})
