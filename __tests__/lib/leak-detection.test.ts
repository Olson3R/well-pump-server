/**
 * @jest-environment node
 *
 * Pure tests for the always-dropping-pressure detector. Exercises bucket
 * monotonicity, recovery rejection, pump-off requirement, freshness, and
 * the distinction between continuous decline (leak) and one-off step drops
 * (a single use event that the detector should not flag).
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

/** 3-hour window with a 2 PSI minimum drop — matches production defaults. */
const T = { minPsiDrop: 2, minDurationMinutes: 180 }

/** Build a `length` minutes-long stream that starts at `startPsi` and decays linearly. */
function linearDecline(length: number, startPsi: number, totalDropPsi: number) {
  const rows: DetectPressureDropRow[] = []
  for (let i = 0; i < length; i++) {
    rows.push(row(i, startPsi - (totalDropPsi * i) / (length - 1)))
  }
  return rows
}

describe('detectContinuousPressureDrop', () => {
  it('returns null with too few rows for bucketing', () => {
    expect(detectContinuousPressureDrop([], T, new Date(BASE))).toBeNull()
  })

  it('fires on a steady linear decline across the full window', () => {
    // 180 rows over 180 minutes, pressure 50 → 47 (3 PSI total).
    const rows = linearDecline(180, 50, 3)
    const now = new Date(BASE + 180 * MINUTE)
    const result = detectContinuousPressureDrop(rows, T, now)
    expect(result).not.toBeNull()
    expect(result!.dropPsi).toBeGreaterThanOrEqual(2)
    expect(result!.bucketAverages.length).toBe(6)
    // Monotonic bucket averages.
    for (let i = 1; i < result!.bucketAverages.length; i++) {
      expect(result!.bucketAverages[i]).toBeLessThan(
        result!.bucketAverages[i - 1],
      )
    }
  })

  it('does not fire when the total drop is below the PSI threshold', () => {
    // 1 PSI drop across the whole window — below the 2 PSI minimum.
    const rows = linearDecline(180, 50, 1)
    const now = new Date(BASE + 180 * MINUTE)
    expect(detectContinuousPressureDrop(rows, T, now)).toBeNull()
  })

  it('rejects a bathtub-style single step (5+ PSI drop concentrated mid-window)', () => {
    // 180-minute window. Flat at 50 for 60 min, single step drop at minute 60,
    // flat at 40 for the rest. This is the classic false-positive case for a
    // naive first-vs-last check; the "distributed drop" rule rejects it.
    const rows: DetectPressureDropRow[] = []
    for (let i = 0; i < 60; i++) rows.push(row(i, 50))
    for (let i = 60; i < 180; i++) rows.push(row(i, 40))
    const now = new Date(BASE + 180 * MINUTE)
    expect(detectContinuousPressureDrop(rows, T, now)).toBeNull()
  })

  it('rejects a window where pressure recovers partway through', () => {
    // Drops 50 → 47 in the first half, recovers to 49 in the second half.
    const rows: DetectPressureDropRow[] = []
    for (let i = 0; i < 90; i++) {
      rows.push(row(i, 50 - (3 * i) / 89))
    }
    for (let i = 90; i < 180; i++) {
      rows.push(row(i, 47 + (2 * (i - 90)) / 89))
    }
    const now = new Date(BASE + 180 * MINUTE)
    expect(detectContinuousPressureDrop(rows, T, now)).toBeNull()
  })

  it('rejects the window when the pump cycled at any point', () => {
    const rows = linearDecline(180, 50, 3)
    // Inject a single pump-on row in the middle.
    rows[90] = { ...rows[90], dutyCycle1: 80 }
    const now = new Date(BASE + 180 * MINUTE)
    expect(detectContinuousPressureDrop(rows, T, now)).toBeNull()
  })

  it('returns null when the most recent row is stale', () => {
    const rows = linearDecline(180, 50, 3)
    const now = new Date(BASE + 200 * MINUTE) // 20 min beyond last sample
    expect(detectContinuousPressureDrop(rows, T, now)).toBeNull()
  })

  it('returns null when coverage of the window is too sparse', () => {
    // Only the last 60 minutes have data — first 120 are missing.
    const rows: DetectPressureDropRow[] = []
    for (let i = 120; i < 180; i++) {
      rows.push(row(i, 50 - (3 * (i - 120)) / 59))
    }
    const now = new Date(BASE + 180 * MINUTE)
    expect(detectContinuousPressureDrop(rows, T, now)).toBeNull()
  })

  it('returns null when zero/negative thresholds disable the check', () => {
    const rows = linearDecline(180, 50, 3)
    const now = new Date(BASE + 180 * MINUTE)
    expect(
      detectContinuousPressureDrop(rows, { ...T, minPsiDrop: 0 }, now),
    ).toBeNull()
    expect(
      detectContinuousPressureDrop(rows, { ...T, minDurationMinutes: 0 }, now),
    ).toBeNull()
  })

  it('tolerates a single noisy bucket bump within the rise threshold', () => {
    // Mostly-linear decline, with mild within-tolerance jitter in one bucket.
    // Drop ≥ 2 PSI total, two of three transitions still meaningful drops.
    const rows = linearDecline(180, 50, 3)
    // Bump a few rows in the third quarter up by 0.5 PSI — well under the
    // 1.0 PSI rise-reject threshold.
    for (let i = 100; i < 120; i++) {
      rows[i] = { ...rows[i], pressMin: rows[i].pressMin + 0.5 }
    }
    const now = new Date(BASE + 180 * MINUTE)
    const result = detectContinuousPressureDrop(rows, T, now)
    expect(result).not.toBeNull()
  })
})
