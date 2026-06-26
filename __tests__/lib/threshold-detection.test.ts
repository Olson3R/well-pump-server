/**
 * @jest-environment node
 *
 * Pure-logic tests for threshold parsing. The DB-driven detection paths are
 * exercised through integration tests; here we lock in the safe-fallback
 * behaviour so a malformed SystemSettings row can never crash the cron tick.
 */
import {
  DEFAULT_THRESHOLDS,
  parseThreshold,
} from '@/lib/threshold-detection'

describe('parseThreshold', () => {
  it('returns fallback when the raw value is undefined', () => {
    expect(parseThreshold(undefined, 42)).toBe(42)
  })

  it('returns fallback for an unparseable string', () => {
    expect(parseThreshold('not-a-number', 5)).toBe(5)
  })

  it('returns fallback for an empty string', () => {
    expect(parseThreshold('', 7)).toBe(7)
  })

  it('returns fallback for a negative value', () => {
    expect(parseThreshold('-1.5', 30)).toBe(30)
  })

  it('returns the parsed value for a valid non-negative number', () => {
    expect(parseThreshold('7.2', 0)).toBeCloseTo(7.2)
    expect(parseThreshold('0', 99)).toBe(0)
  })

  it('returns fallback for NaN-producing input like whitespace', () => {
    expect(parseThreshold('   ', 12)).toBe(12)
  })
})

describe('DEFAULT_THRESHOLDS', () => {
  it('exposes the documented seed values', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      highCurrentAmps: 7.2,
      lowPressurePsi: 30,
      lowTemperatureF: 35,
      missingDataMinutes: 10,
    })
  })
})
