'use client'

import { useEffect, useState } from 'react'

export interface LastUpdatedProps {
  /** Timestamp of the last successful refresh, or null if none has succeeded. */
  date: Date | null
  /** True while a refresh is in flight — shows a subtle "updating" hint. */
  loading?: boolean
  /** True when auto-refresh is paused (e.g. the tab is hidden). */
  isPaused?: boolean
  /** Extra classes for the wrapping element. */
  className?: string
}

/**
 * Convert an elapsed duration (ms) into a compact, human "x ago" label.
 * Kept deliberately coarse — second/minute/hour buckets are plenty for a
 * "last updated" hint and avoid noisy re-renders.
 */
export function formatRelativeTime(elapsedMs: number): string {
  if (elapsedMs < 0) elapsedMs = 0
  const seconds = Math.floor(elapsedMs / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/**
 * Live "last updated" indicator for auto-refreshing screens.
 *
 * Shows a relative label ("Updated 12s ago") that ticks every second so it
 * stays accurate between refreshes, with the absolute time available on hover
 * (`title`). Surfaces "Updating…" while a refresh is in flight and "paused"
 * when polling is suspended (hidden tab). Pairs with {@link useAutoRefresh}.
 */
export function LastUpdated({
  date,
  loading = false,
  isPaused = false,
  className = '',
}: LastUpdatedProps) {
  // Re-render once per second so the relative label stays fresh without the
  // parent having to re-run its refresh.
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!date) return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [date])

  let label: string
  if (loading && !date) {
    label = 'Loading…'
  } else if (loading) {
    label = 'Updating…'
  } else if (!date) {
    label = 'Not yet updated'
  } else {
    label = `Updated ${formatRelativeTime(Date.now() - date.getTime())}`
  }

  return (
    <span
      className={`inline-flex items-center text-sm text-gray-500 ${className}`}
      data-testid="last-updated"
      title={date ? date.toLocaleString() : undefined}
      aria-live="polite"
    >
      <span
        className={`mr-2 h-2 w-2 rounded-full ${
          loading
            ? 'bg-blue-500 animate-pulse'
            : isPaused
              ? 'bg-gray-400'
              : 'bg-green-500'
        }`}
        aria-hidden="true"
      />
      {label}
      {isPaused && !loading && (
        <span className="ml-1 text-gray-400">(paused)</span>
      )}
    </span>
  )
}

export default LastUpdated
