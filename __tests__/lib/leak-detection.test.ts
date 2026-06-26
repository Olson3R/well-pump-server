/**
 * @jest-environment node
 *
 * Pure tests for the continuous-pressure-drop detector. The DB-backed
 * reconciliation path is left to integration; here we lock in the algorithmic
 * decisions (segment selection, freshness, trailing-window peak, thresholds).
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

const T = { minPsiDrop: 3, minDurationMinutes: 10 }

describe('detectContinuousPressureDrop', () => {
  it('returns null with no rows', () => {
    expect(detectContinuousPressureDrop([], T, new Date(BASE))).toBeNull()
  })

  it('fires on a sustained drop while pump is off', () => {
    // 12 pump-off rows, pressure 50 -> 45 over 12 minutes.
    const rows: DetectPressureDropRow[] = []
    for (let i = 0; i < 12; i++) rows.push(row(i, 50 - i * 0.5))
    const now = new Date(BASE + 12 * MINUTE)
    const result = detectContinuousPressureDrop(rows, T, now)
    expect(result).not.toBeNull()
    // Trailing 10-min window starts at minute 1, so peak is 49.5 not 50.
    expect(result!.dropPsi).toBeCloseTo(5.0, 1)
    expect(result!.durationMinutes).toBeGreaterThanOrEqual(10)
  })

  it('does not fire when the drop is below the PSI threshold', () => {
    // 12 pump-off rows but only 1 PSI of total drop.
    const rows: DetectPressureDropRow[] = []
    for (let i = 0; i < 12; i++) rows.push(row(i, 50 - i * (1 / 11)))
    const now = new Date(BASE + 12 * MINUTE)
    expect(detectContinuousPressureDrop(rows, T, now)).toBeNull()
  })

  it('does not fire when the pump-off segment is shorter than the window', () => {
    // 6 pump-off rows after a pump cycle — not long enough.
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => row(i, 50, 100)),
      ...Array.from({ length: 6 }, (_, i) => row(5 + i, 50 - i * 1.5)),
    ]
    const now = new Date(BASE + 11 * MINUTE)
    expect(detectContinuousPressureDrop(rows, T, now)).toBeNull()
  })

  it('does not fire when the most recent row is stale', () => {
    const rows: DetectPressureDropRow[] = []
    for (let i = 0; i < 12; i++) rows.push(row(i, 50 - i * 0.5))
    // 10 minutes have passed since the last sample.
    const now = new Date(BASE + 22 * MINUTE)
    expect(detectContinuousPressureDrop(rows, T, now)).toBeNull()
  })

  it('considers only the trailing window when picking the peak', () => {
    // Pressure crashed early then stabilised; latest 10 min show no drop.
    const rows: DetectPressureDropRow[] = [
      row(0, 50),
      row(1, 40), // sharp drop early
      ...Array.from({ length: 13 }, (_, i) => row(2 + i, 40)),
    ]
    const now = new Date(BASE + 15 * MINUTE)
    // Within the last 10 min, pressure is flat at 40 — no alert.
    expect(detectContinuousPressureDrop(rows, T, now)).toBeNull()
  })

  it('starts a fresh evaluation after a pump cycle', () => {
    // Long drop, then pump cycled, then only short pump-off afterwards.
    const rows = [
      row(0, 50),
      row(1, 47),
      row(2, 44),
      row(3, 41),
      row(4, 38),
      row(5, 50, 100), // pump on
      row(6, 50),
      row(7, 49),
      row(8, 49),
    ]
    const now = new Date(BASE + 9 * MINUTE)
    // Post-cycle pump-off segment is only ~3 minutes — too short.
    expect(detectContinuousPressureDrop(rows, T, now)).toBeNull()
  })

  it('returns null when the threshold itself is zero/negative', () => {
    const rows: DetectPressureDropRow[] = []
    for (let i = 0; i < 12; i++) rows.push(row(i, 50 - i * 0.5))
    const now = new Date(BASE + 12 * MINUTE)
    expect(
      detectContinuousPressureDrop(rows, { ...T, minPsiDrop: 0 }, now),
    ).toBeNull()
    expect(
      detectContinuousPressureDrop(rows, { ...T, minDurationMinutes: 0 }, now),
    ).toBeNull()
  })
})
