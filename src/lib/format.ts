/**
 * Presentation helpers for the dashboard stats UI.
 *
 * These turn the raw scalars returned by `/api/stats` (counts and durations in
 * seconds) into compact, human-readable strings. They are deliberately pure and
 * side-effect free so they can be unit-tested in isolation and reused anywhere a
 * stat needs rendering.
 */

const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR

/**
 * Format a duration (in seconds) as a compact human label, e.g.
 *
 *   0        -> "0s"
 *   45       -> "45s"
 *   90       -> "1m 30s"
 *   3600     -> "1h"
 *   3661     -> "1h 1m"
 *   90000    -> "1d 1h"
 *
 * Shows at most the two most-significant non-zero units (days/hours/minutes/
 * seconds) so the label stays glanceable. Sub-second precision is rounded to the
 * nearest second. Negative / non-finite inputs are treated as zero.
 */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0s'

  const whole = Math.round(totalSeconds)
  if (whole === 0) return '0s'

  const days = Math.floor(whole / SECONDS_PER_DAY)
  const hours = Math.floor((whole % SECONDS_PER_DAY) / SECONDS_PER_HOUR)
  const minutes = Math.floor((whole % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)
  const seconds = whole % SECONDS_PER_MINUTE

  const parts: string[] = []
  if (days) parts.push(`${days}d`)
  if (hours) parts.push(`${hours}h`)
  if (minutes) parts.push(`${minutes}m`)
  if (seconds) parts.push(`${seconds}s`)

  // Keep only the two most-significant non-zero units.
  return parts.slice(0, 2).join(' ')
}

/**
 * Format an integer count with locale grouping (e.g. 1234 -> "1,234"). Non-finite
 * or negative inputs collapse to "0". Fractional inputs are rounded.
 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  return Math.round(value).toLocaleString('en-US')
}
