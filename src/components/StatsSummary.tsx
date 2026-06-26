'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  ArrowPathIcon,
  BoltIcon,
  ClockIcon,
  ArrowTrendingDownIcon,
  ExclamationCircleIcon,
} from '@heroicons/react/24/outline'
import { useAutoRefresh } from '@/hooks/useAutoRefresh'
import { LastUpdated } from '@/components/LastUpdated'
import { formatCount, formatDuration } from '@/lib/format'

/**
 * The aggregated stats payload returned by `GET /api/stats` (the `stats` field).
 * Mirrors `AggregatedStats` in `@/lib/stats`.
 */
export interface AggregatedStats {
  pumpRunCount: number
  pumpDurationSeconds: number
  pumpDurationMs: number
  lowPressureEventCount: number
  lowPressureDurationSeconds: number
  lowPressureDurationMs: number
  sampleCount: number
  averagePumpRunSeconds: number
  averageLowPressureSeconds: number
}

interface StatsResponse {
  stats?: AggregatedStats
}

/** Selectable summary windows. `all` sends no date bounds (lifetime totals). */
type RangeKey = '24h' | '7d' | '30d' | 'all'

interface RangeOption {
  key: RangeKey
  label: string
}

const RANGE_OPTIONS: readonly RangeOption[] = [
  { key: '24h', label: 'Last 24 Hours' },
  { key: '7d', label: 'Last 7 Days' },
  { key: '30d', label: 'Last 30 Days' },
  { key: 'all', label: 'All Time' },
] as const

/** One minute — the shared auto-refresh cadence across the live screens. */
const AUTO_REFRESH_MS = 60_000

/**
 * Resolve a {@link RangeKey} to an absolute `[start, end]` window. `all` returns
 * a null start so the endpoint aggregates over every row. Pure so it can be
 * unit-tested and reused by both the manual and auto-refresh paths.
 */
export function resolveStatsRange(range: RangeKey): {
  start: Date | null
  end: Date | null
} {
  if (range === 'all') return { start: null, end: null }

  const end = new Date()
  const start = new Date(end)
  switch (range) {
    case '24h':
      start.setDate(start.getDate() - 1)
      break
    case '7d':
      start.setDate(start.getDate() - 7)
      break
    case '30d':
      start.setDate(start.getDate() - 30)
      break
  }
  return { start, end }
}

interface StatCardProps {
  label: string
  value: string
  /** Secondary line (e.g. an average), hidden when absent. */
  detail?: string
  icon: typeof BoltIcon
  iconClass: string
  loading: boolean
  testId: string
}

/** A single headline stat tile with an icon, primary value and optional detail. */
function StatCard({
  label,
  value,
  detail,
  icon: Icon,
  iconClass,
  loading,
  testId,
}: StatCardProps) {
  return (
    <div className="bg-white overflow-hidden shadow rounded-lg" data-testid={testId}>
      <div className="p-5">
        <div className="flex items-center">
          <div className="flex-shrink-0">
            <Icon className={`h-8 w-8 ${iconClass}`} aria-hidden="true" />
          </div>
          <div className="ml-5 w-0 flex-1">
            <dl>
              <dt className="text-sm font-medium text-gray-500 truncate">
                {label}
              </dt>
              {loading ? (
                <dd className="mt-1">
                  <div
                    className="h-7 w-20 bg-gray-200 rounded animate-pulse"
                    aria-hidden="true"
                  />
                  <span className="sr-only">Loading {label}</span>
                </dd>
              ) : (
                <dd
                  className="text-2xl font-bold text-gray-900"
                  data-testid={`${testId}-value`}
                >
                  {value}
                </dd>
              )}
              {!loading && detail && (
                <dd className="mt-1 text-xs text-gray-500" data-testid={`${testId}-detail`}>
                  {detail}
                </dd>
              )}
            </dl>
          </div>
        </div>
      </div>
    </div>
  )
}

export interface StatsSummaryProps {
  /** Restrict the aggregation to a single device. */
  device?: string
  /** Initial range selection. Defaults to the last 24 hours. */
  initialRange?: RangeKey
  /** Extra classes for the wrapping section. */
  className?: string
}

/**
 * Dashboard panel presenting the four aggregated operational stats from
 * `GET /api/stats` — pump runs, total pump runtime, low-pressure events and
 * total low-pressure time — with derived per-run/per-event averages.
 *
 * Self-contained: owns a range selector and an independent {@link useAutoRefresh}
 * instance (one-minute poll + manual refresh + pause-when-hidden), so the panel
 * keeps the user's selected window fresh without coupling to the rest of the
 * dashboard's refresh cycle. Changing the range re-queries immediately.
 */
export function StatsSummary({
  device,
  initialRange = '24h',
  className = '',
}: StatsSummaryProps) {
  const [range, setRange] = useState<RangeKey>(initialRange)
  const [stats, setStats] = useState<AggregatedStats | null>(null)

  const fetchStats = useCallback(
    async (signal: AbortSignal) => {
      const { start, end } = resolveStatsRange(range)
      const params = new URLSearchParams()
      if (start) params.set('startDate', start.toISOString())
      if (end) params.set('endDate', end.toISOString())
      if (device) params.set('device', device)

      const query = params.toString()
      const res = await fetch(`/api/stats${query ? `?${query}` : ''}`, { signal })
      if (!res.ok) {
        throw new Error(`Stats request failed (${res.status})`)
      }
      const body: StatsResponse = await res.json()
      if (signal.aborted) return
      setStats(body.stats ?? null)
    },
    [range, device]
  )

  // The hook owns the interval poll + visibility behaviour; mount and
  // range/device changes are driven by the effect below so a range switch
  // re-queries straight away (the hook intentionally does not re-run when its
  // callback identity changes).
  const { loading, lastUpdated, error, isPaused, refresh } = useAutoRefresh(
    fetchStats,
    { intervalMs: AUTO_REFRESH_MS, immediate: false }
  )

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, device])

  // First load shows skeletons; later refreshes keep the prior values visible.
  const showSkeleton = loading && !stats

  return (
    <section className={className} aria-label="Aggregated statistics">
      <div className="sm:flex sm:items-center sm:justify-between mb-4">
        <h3 className="text-lg leading-6 font-medium text-gray-900">
          Operational Stats
        </h3>
        <div className="mt-3 flex items-center gap-3 sm:mt-0">
          <LastUpdated date={lastUpdated} loading={loading} isPaused={isPaused} />
          <label htmlFor="stats-range" className="sr-only">
            Stats time range
          </label>
          <select
            id="stats-range"
            value={range}
            onChange={(e) => setRange(e.target.value as RangeKey)}
            className="block pl-3 pr-10 py-2 text-sm border-gray-300 focus:outline-none focus:ring-blue-500 focus:border-blue-500 rounded-md"
          >
            {RANGE_OPTIONS.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {opt.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => { void refresh() }}
            disabled={loading}
            className="inline-flex items-center px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="Refresh stats"
          >
            <ArrowPathIcon
              className={`h-5 w-5 ${loading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4 mb-4 text-sm"
        >
          Failed to load stats. Retrying automatically…
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Pump Runs"
          value={formatCount(stats?.pumpRunCount ?? 0)}
          detail={
            stats && stats.pumpRunCount > 0
              ? `avg ${formatDuration(stats.averagePumpRunSeconds)} / run`
              : undefined
          }
          icon={BoltIcon}
          iconClass="text-blue-600"
          loading={showSkeleton}
          testId="stat-pump-runs"
        />
        <StatCard
          label="Pump Runtime"
          value={formatDuration(stats?.pumpDurationSeconds ?? 0)}
          detail={
            stats && stats.sampleCount > 0
              ? `over ${formatCount(stats.sampleCount)} samples`
              : undefined
          }
          icon={ClockIcon}
          iconClass="text-green-600"
          loading={showSkeleton}
          testId="stat-pump-runtime"
        />
        <StatCard
          label="Low-Pressure Events"
          value={formatCount(stats?.lowPressureEventCount ?? 0)}
          detail={
            stats && stats.lowPressureEventCount > 0
              ? `avg ${formatDuration(stats.averageLowPressureSeconds)} / event`
              : undefined
          }
          icon={ArrowTrendingDownIcon}
          iconClass="text-amber-600"
          loading={showSkeleton}
          testId="stat-low-pressure-events"
        />
        <StatCard
          label="Low-Pressure Time"
          value={formatDuration(stats?.lowPressureDurationSeconds ?? 0)}
          icon={ExclamationCircleIcon}
          iconClass="text-red-600"
          loading={showSkeleton}
          testId="stat-low-pressure-time"
        />
      </div>
    </section>
  )
}

export default StatsSummary
