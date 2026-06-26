import { formatDuration, formatCount } from '@/lib/format'

describe('formatDuration', () => {
  it('returns "0s" for zero, negative and non-finite input', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(-10)).toBe('0s')
    expect(formatDuration(NaN)).toBe('0s')
    expect(formatDuration(Infinity)).toBe('0s')
  })

  it('formats sub-minute durations in seconds', () => {
    expect(formatDuration(1)).toBe('1s')
    expect(formatDuration(45)).toBe('45s')
    expect(formatDuration(59)).toBe('59s')
  })

  it('rounds fractional seconds to the nearest second', () => {
    expect(formatDuration(0.4)).toBe('0s')
    expect(formatDuration(0.6)).toBe('1s')
    expect(formatDuration(89.6)).toBe('1m 30s')
  })

  it('formats minutes and seconds', () => {
    expect(formatDuration(60)).toBe('1m')
    expect(formatDuration(90)).toBe('1m 30s')
    expect(formatDuration(599)).toBe('9m 59s')
  })

  it('formats hours, dropping zero units', () => {
    expect(formatDuration(3600)).toBe('1h')
    expect(formatDuration(3661)).toBe('1h 1m')
    expect(formatDuration(7200)).toBe('2h')
  })

  it('formats days and keeps only the two most-significant units', () => {
    expect(formatDuration(SECONDS('1d'))).toBe('1d')
    expect(formatDuration(SECONDS('1d') + SECONDS('1h'))).toBe('1d 1h')
    // 1d 2h 3m 4s -> only the two leading units.
    expect(
      formatDuration(SECONDS('1d') + 2 * 3600 + 3 * 60 + 4)
    ).toBe('1d 2h')
  })
})

describe('formatCount', () => {
  it('formats integers with locale grouping', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(12)).toBe('12')
    expect(formatCount(1234)).toBe('1,234')
    expect(formatCount(1234567)).toBe('1,234,567')
  })

  it('rounds fractional counts', () => {
    expect(formatCount(2.4)).toBe('2')
    expect(formatCount(2.5)).toBe('3')
  })

  it('collapses negative and non-finite values to "0"', () => {
    expect(formatCount(-5)).toBe('0')
    expect(formatCount(NaN)).toBe('0')
    expect(formatCount(Infinity)).toBe('0')
  })
})

/** Tiny helper so the day-based expectations above read clearly. */
function SECONDS(label: '1d' | '1h'): number {
  return label === '1d' ? 86400 : 3600
}
