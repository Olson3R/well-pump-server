'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A refresh callback. Receives an {@link AbortSignal} that is aborted when the
 * component unmounts (or a newer refresh supersedes it) so in-flight `fetch`
 * calls can be cancelled. May be sync or async; the hook awaits the result and
 * treats a thrown/rejected error as a failed refresh.
 */
export type RefreshCallback = (signal: AbortSignal) => void | Promise<void>

export interface UseAutoRefreshOptions {
  /** Poll interval in milliseconds. Defaults to 60_000 (one minute). */
  intervalMs?: number
  /**
   * When false the hook neither polls nor runs the initial refresh, and any
   * scheduled interval is torn down. Defaults to true.
   */
  enabled?: boolean
  /** Run a refresh immediately on mount (and whenever re-enabled). Defaults to true. */
  immediate?: boolean
  /**
   * Stop polling while the document is hidden (tab in background / device
   * asleep). Avoids pointless network traffic the user can't see. Defaults to true.
   */
  pauseWhenHidden?: boolean
  /**
   * When the document becomes visible again, immediately refresh if at least
   * `intervalMs` has elapsed since the last successful update (so the user sees
   * fresh data on return rather than waiting for the next tick). Defaults to true.
   * Has no effect when `pauseWhenHidden` is false.
   */
  refreshOnVisible?: boolean
}

export interface UseAutoRefreshResult {
  /**
   * Manually trigger a refresh. Returns a promise that resolves once the
   * refresh settles. If a refresh is already in flight this is a no-op and
   * resolves immediately (single-flight — no overlapping requests).
   */
  refresh: () => Promise<void>
  /** True while a refresh (manual or automatic) is in flight. */
  loading: boolean
  /** Timestamp of the last *successful* refresh, or null if none has succeeded. */
  lastUpdated: Date | null
  /** Error from the most recent failed refresh, cleared on the next attempt. */
  error: Error | null
  /** True when polling is currently paused because the document is hidden. */
  isPaused: boolean
}

const DEFAULT_INTERVAL_MS = 60_000

/**
 * Shared auto/manual refresh primitive.
 *
 * Polls `callback` on a fixed interval (default 60s), exposes a manual
 * `refresh()` trigger, tracks `loading` / `lastUpdated` / `error` state, and
 * pauses polling while the tab is hidden — resuming (and optionally refreshing)
 * when it becomes visible again. Guarantees single-flight execution so a slow
 * request never overlaps the next tick.
 *
 * Consumed by the dashboard and data screens.
 *
 * @example
 * const { loading, lastUpdated, error, refresh } = useAutoRefresh(
 *   async (signal) => {
 *     const res = await fetch('/api/sensors?limit=1', { signal })
 *     setData(await res.json())
 *   }
 * )
 */
export function useAutoRefresh(
  callback: RefreshCallback,
  options: UseAutoRefreshOptions = {}
): UseAutoRefreshResult {
  const {
    intervalMs = DEFAULT_INTERVAL_MS,
    enabled = true,
    immediate = true,
    pauseWhenHidden = true,
    refreshOnVisible = true,
  } = options

  const [loading, setLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [hidden, setHidden] = useState(false)

  // Keep the latest callback without re-creating `refresh` (which would reset
  // the polling interval) every time the consumer passes a new closure.
  const callbackRef = useRef(callback)
  useEffect(() => {
    callbackRef.current = callback
  }, [callback])

  // Guards/refs that must not trigger re-renders or stale closures.
  const inFlightRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const lastUpdatedMsRef = useRef(0)
  const mountedRef = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    // Single-flight: never overlap requests.
    if (inFlightRef.current) return
    inFlightRef.current = true

    const controller = new AbortController()
    abortRef.current = controller

    setLoading(true)
    setError(null)

    try {
      await callbackRef.current(controller.signal)
      if (!controller.signal.aborted && mountedRef.current) {
        const now = Date.now()
        lastUpdatedMsRef.current = now
        setLastUpdated(new Date(now))
      }
    } catch (err) {
      if (!controller.signal.aborted && mountedRef.current) {
        setError(err instanceof Error ? err : new Error(String(err)))
      }
    } finally {
      if (!controller.signal.aborted && mountedRef.current) {
        setLoading(false)
      }
      inFlightRef.current = false
    }
  }, [])

  // Track document visibility (pause-when-hidden) and refresh-on-return.
  useEffect(() => {
    if (typeof document === 'undefined') return

    setHidden(document.hidden)

    const handleVisibilityChange = () => {
      const isHidden = document.hidden
      setHidden(isHidden)

      if (
        !isHidden &&
        enabled &&
        pauseWhenHidden &&
        refreshOnVisible &&
        Date.now() - lastUpdatedMsRef.current >= intervalMs
      ) {
        void refresh()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () =>
      document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [enabled, pauseWhenHidden, refreshOnVisible, intervalMs, refresh])

  // Initial refresh on mount / when (re)enabled.
  useEffect(() => {
    if (enabled && immediate) {
      void refresh()
    }
  }, [enabled, immediate, refresh])

  // Polling interval. Torn down (paused) while disabled or hidden.
  useEffect(() => {
    if (!enabled) return
    if (pauseWhenHidden && hidden) return

    const id = setInterval(() => {
      void refresh()
    }, intervalMs)

    return () => clearInterval(id)
  }, [enabled, pauseWhenHidden, hidden, intervalMs, refresh])

  // Abort any in-flight request on unmount and stop late state updates.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  return {
    refresh,
    loading,
    lastUpdated,
    error,
    isPaused: enabled && pauseWhenHidden && hidden,
  }
}

export default useAutoRefresh
