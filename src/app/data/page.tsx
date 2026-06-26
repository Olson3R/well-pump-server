'use client'

import { ProtectedRoute } from '@/components/ProtectedRoute'
import { Navigation } from '@/components/Navigation'
import { LastUpdated } from '@/components/LastUpdated'
import { useAutoRefresh } from '@/hooks/useAutoRefresh'
import { useState, useEffect, useCallback } from 'react'
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceArea,
  ResponsiveContainer
} from 'recharts'
import { format } from 'date-fns'
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ChartBarIcon,
  TableCellsIcon,
  XMarkIcon
} from '@heroicons/react/24/outline'

interface SensorData {
  id: string
  timestamp: string
  tempAvg: number
  humAvg: number
  pressAvg: number
  current1Avg: number
  current2Avg: number
  current1RMS: number
  current2RMS: number
  dutyCycle1: number
  dutyCycle2: number
}

interface Pagination {
  total: number
  limit?: number
  offset: number
  returned: number
  hasMore: boolean
}

interface Aggregation {
  interval: 'hour' | '6hour' | 'day'
  auto: boolean
  startDate: string
  endDate: string
}

interface SensorResponse {
  data?: SensorData[]
  pagination?: Pagination
  aggregation?: Aggregation
}

/**
 * Summary of what the most recent fetch actually loaded — surfaced in the UI so
 * the user can confirm the charts/tables cover the entire requested window.
 */
interface LoadMeta {
  points: number
  aggregation: Aggregation | null
  pages: number
  truncated: boolean
}

/**
 * Page size used when paging raw rows. Mirrors the backend's MAX_RAW_ROWS so a
 * single page pulls the largest un-aggregated batch the server will return.
 */
const RAW_PAGE_SIZE = 5000

/**
 * Hard safety stop for the "load all in range" loop so a runaway/looping
 * pagination response can never spin forever. RAW_PAGE_SIZE * MAX_PAGES rows is
 * far more than any realistic selected window.
 */
const MAX_PAGES = 100

const AGGREGATE_LABEL: Record<Aggregation['interval'], string> = {
  hour: 'hourly average',
  '6hour': '6-hour average',
  day: 'daily average',
}

/** One minute — the shared auto-refresh cadence for the live data screens. */
const AUTO_REFRESH_MS = 60_000

/**
 * Translate the active selection into an absolute [start, end] window plus an
 * optional aggregation hint. Pure (no component state) so it can be reused by
 * both the manual and the auto-refresh paths and unit-tested in isolation.
 *
 * `selectedRange` (a drag-zoom on the chart) wins over both presets and the
 * custom date bounds — the user is asking for an explicit ms-precision window.
 *
 * Both custom bounds are derived in the SAME (local) zone: parsing a bare
 * 'YYYY-MM-DD' yields UTC midnight, which—paired with a local end-of-day—
 * previously dropped the final selected day in non-UTC zones. Explicit
 * local-time components keep the full range intact.
 */
function resolveWindow(
  timeRange: string,
  customStart?: string,
  customEnd?: string,
  selectedRange?: { start: Date; end: Date } | null
): { startDate: Date; endDate: Date; aggregate: string } {
  if (selectedRange) {
    const { start: startDate, end: endDate } = selectedRange
    const spanDays =
      (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)
    let aggregate = ''
    if (spanDays > 7) aggregate = '6hour'
    else if (spanDays > 1) aggregate = 'hour'
    return { startDate, endDate, aggregate }
  }

  let startDate: Date
  let endDate: Date
  let aggregate = ''

  if (timeRange === 'custom' && customStart && customEnd) {
    startDate = new Date(`${customStart}T00:00:00`)
    endDate = new Date(`${customEnd}T23:59:59.999`)

    const spanDays =
      (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)
    if (spanDays > 7) {
      aggregate = '6hour' // > 7 days: aggregate by 6 hours
    } else if (spanDays > 1) {
      aggregate = 'hour' // > 1 day: aggregate by hour
    }
    // <= 1 day: no aggregation (raw data)
  } else {
    endDate = new Date()
    startDate = new Date()

    switch (timeRange) {
      case '1h':
        startDate.setHours(startDate.getHours() - 1)
        break
      case '24h':
        startDate.setDate(startDate.getDate() - 1)
        break
      case '7d':
        startDate.setDate(startDate.getDate() - 7)
        aggregate = 'hour'
        break
      case '30d':
        startDate.setDate(startDate.getDate() - 30)
        aggregate = '6hour'
        break
    }
  }

  return { startDate, endDate, aggregate }
}

export default function DataPage() {
  const [data, setData] = useState<SensorData[]>([])
  const [view, setView] = useState<'table' | 'chart'>('chart')
  const [timeRange, setTimeRange] = useState('24h')
  const [customStartDate, setCustomStartDate] = useState('')
  const [customEndDate, setCustomEndDate] = useState('')
  const [dateRangeSpan, setDateRangeSpan] = useState(1) // days
  const [loadMeta, setLoadMeta] = useState<LoadMeta | null>(null)
  // A custom range is only auto-refreshed AFTER the user explicitly loads it
  // (clicks "Load Data"); editing the dates again disarms it until re-loaded.
  // This keeps the poll from firing against a window the user is still picking.
  const [customLoaded, setCustomLoaded] = useState(false)

  // Drag-zoom: an explicit ms-precision window committed by dragging across any
  // chart. When set it overrides the dropdown / custom dates until cleared.
  const [selectedRange, setSelectedRange] = useState<{ start: Date; end: Date } | null>(null)
  // In-progress drag selection (shared across all charts so the highlight is
  // visible everywhere while the user drags). Cleared on mouseup / mouseleave.
  const [dragStart, setDragStart] = useState<number | null>(null)
  const [dragEnd, setDragEnd] = useState<number | null>(null)

  // Whether the current selection is queryable. A drag-zoomed range always is;
  // preset ranges always are; a custom range only once it's been loaded.
  const canQuery = !!selectedRange || timeRange !== 'custom' || customLoaded

  /**
   * Load the ENTIRE active window and replace the dataset. Reads the current
   * selection (range / custom bounds) on every invocation, so both auto-refresh
   * and manual refresh keep the user's selected range intact.
   *
   * The backend returns either every row in the window, a transparently
   * downsampled series, or—for the rare capped case—a raw page that signals
   * `hasMore`. We follow `hasMore` with offset paging until the whole window has
   * been pulled, so charts/tables always reflect the full range. Most requests
   * resolve in a single page (hasMore=false). The {@link AbortSignal} cancels
   * in-flight pages on unmount or when a newer refresh supersedes this one.
   */
  const loadWindow = useCallback(
    async (signal: AbortSignal) => {
      // Custom range without both bounds: nothing to query. Leave the existing
      // data/coverage intact and don't record a (mis)load. A drag-zoom
      // selection bypasses this gate (it carries its own bounds).
      if (!selectedRange && timeRange === 'custom' && !(customStartDate && customEndDate)) {
        return
      }

      const { startDate, endDate, aggregate } = resolveWindow(
        timeRange,
        customStartDate,
        customEndDate,
        selectedRange
      )

      // Record span (drives x-axis label formatting).
      const spanDays =
        (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)
      setDateRangeSpan(spanDays)

      const baseUrl =
        `/api/sensors?startDate=${encodeURIComponent(startDate.toISOString())}` +
        `&endDate=${encodeURIComponent(endDate.toISOString())}` +
        (aggregate ? `&aggregate=${aggregate}` : '')

      // --- Load the ENTIRE selected window -------------------------------------
      const collected: SensorData[] = []
      let aggregation: Aggregation | null = null
      let offset = 0
      let pages = 0
      let truncated = false

      while (pages < MAX_PAGES) {
        // Page 0 is unbounded (lets the server choose raw-vs-downsample).
        // Subsequent pages request an explicit raw page at the running offset.
        const url =
          pages === 0
            ? baseUrl
            : `${baseUrl}&limit=${RAW_PAGE_SIZE}&offset=${offset}`

        const response = await fetch(url, { signal })
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`)
        }
        const result: SensorResponse = await response.json()
        pages += 1

        if (Array.isArray(result.data)) {
          collected.push(...result.data)
        }
        if (result.aggregation) {
          aggregation = result.aggregation
        }

        const p = result.pagination
        if (!p || !p.hasMore) break

        // Advance past everything seen so far. Prefer the server's own counters
        // and fall back to what we received to avoid an infinite loop.
        const returned = p.returned ?? result.data?.length ?? 0
        if (returned === 0) break // defensive: no progress => stop
        offset = (p.offset ?? offset) + returned

        if (pages >= MAX_PAGES) {
          truncated = true
        }
      }

      // A superseding refresh / unmount aborted us mid-flight — discard the
      // partial result rather than clobbering newer state.
      if (signal.aborted) return

      // The API returns newest-first; charts/tables read oldest-first.
      collected.reverse()
      setData(collected)
      setLoadMeta({
        points: collected.length,
        aggregation,
        pages,
        truncated,
      })
    },
    [timeRange, customStartDate, customEndDate, selectedRange]
  )

  // Shared auto/manual refresh: polls every minute, pauses on a hidden tab, and
  // exposes loading / lastUpdated / error plus a manual `refresh()` trigger.
  // Mount + range-change fetches are driven by the effect below (so a custom
  // range isn't queried until the user loads it); the hook owns only the
  // interval poll + visibility behaviour, hence `immediate: false`.
  const { loading, lastUpdated, error, isPaused, refresh } = useAutoRefresh(
    loadWindow,
    {
      intervalMs: AUTO_REFRESH_MS,
      immediate: false,
      enabled: canQuery,
    }
  )

  // Fetch on mount and whenever a non-custom range is selected. Switching range
  // also disarms any previously-loaded custom window. A custom range waits for
  // an explicit "Load Data" so we never query a half-entered window.
  useEffect(() => {
    setCustomLoaded(false)
    if (timeRange !== 'custom') {
      void refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeRange])

  // Editing either custom bound disarms auto-refresh until the user re-loads,
  // so the poll can't fire against a window that's mid-edit.
  useEffect(() => {
    setCustomLoaded(false)
  }, [customStartDate, customEndDate])

  // Committing a drag-zoom selection refetches at the new window. Clearing it
  // (back to null) falls through to the dropdown / custom path on the next
  // refresh — no immediate fetch needed because that's what the other effects
  // are for.
  useEffect(() => {
    if (selectedRange) {
      void refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRange])

  const handleRefresh = () => {
    void refresh()
  }

  const handleCustomDateFetch = () => {
    if (customStartDate && customEndDate) {
      setSelectedRange(null)
      setCustomLoaded(true)
      void refresh()
    }
  }

  const handleTimeRangeChange = (value: string) => {
    setSelectedRange(null)
    setTimeRange(value)
  }

  const handleClearSelection = () => {
    setSelectedRange(null)
    // Re-query the active dropdown / custom window so the chart reverts to it
    // without waiting for the next auto-refresh tick.
    if (timeRange !== 'custom' || customLoaded) {
      void refresh()
    }
  }

  // Recharts mouse-event payload — `activeLabel` is the value of the X-axis
  // dataKey at the cursor (ms timestamp, since we use a numeric axis).
  type ChartEvent = { activeLabel?: number | string } | null
  const handleChartMouseDown = (e: ChartEvent) => {
    if (e?.activeLabel == null) return
    const t = Number(e.activeLabel)
    if (!Number.isFinite(t)) return
    setDragStart(t)
    setDragEnd(null)
  }
  const handleChartMouseMove = (e: ChartEvent) => {
    if (dragStart == null || e?.activeLabel == null) return
    const t = Number(e.activeLabel)
    if (!Number.isFinite(t)) return
    setDragEnd(t)
  }
  const handleChartMouseUp = () => {
    if (dragStart != null && dragEnd != null && dragStart !== dragEnd) {
      const start = new Date(Math.min(dragStart, dragEnd))
      const end = new Date(Math.max(dragStart, dragEnd))
      setSelectedRange({ start, end })
    }
    setDragStart(null)
    setDragEnd(null)
  }
  const handleChartMouseLeave = () => {
    setDragStart(null)
    setDragEnd(null)
  }

  const exportData = async (format: 'json' | 'csv') => {
    try {
      const response = await fetch(`/api/export?format=${format}&type=sensors&${new URLSearchParams({
        startDate: data[0]?.timestamp || '',
        endDate: data[data.length - 1]?.timestamp || ''
      })}`)
      
      if (response.ok) {
        const blob = await response.blob()
        const url = window.URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `sensor-data.${format}`
        document.body.appendChild(a)
        a.click()
        window.URL.revokeObjectURL(url)
        document.body.removeChild(a)
      }
    } catch (error) {
      console.error('Error exporting data:', error)
    }
  }

  // Pick a tick label format from the actual visible span — driven by the
  // resolved window rather than the dropdown, so a drag-zoomed selection picks
  // an appropriate format too (e.g. zooming into 30 min of a 30d view should
  // show HH:mm, not "MMM d").
  const dateFormat =
    dateRangeSpan > 7 ? 'MMM d' : dateRangeSpan > 1 ? 'EEE HH:mm' : 'HH:mm'
  const formatTick = (ts: number) => format(new Date(ts), dateFormat)

  const chartData = data.map(d => ({
    ...d,
    timestamp: new Date(d.timestamp).getTime(),
  }))

  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-gray-50">
        <Navigation />
        
        <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
          {/* Header */}
          <div className="md:flex md:items-center md:justify-between mb-6">
            <div className="flex-1 min-w-0">
              <h2 className="text-2xl font-bold leading-7 text-gray-900 sm:text-3xl sm:truncate">
                Sensor Data
              </h2>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2 md:mt-0 md:ml-4">
              <LastUpdated
                date={lastUpdated}
                loading={loading}
                isPaused={isPaused}
                className="mr-2"
              />
              <button
                onClick={handleRefresh}
                disabled={loading}
                className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Refresh data"
              >
                <ArrowPathIcon className={`h-5 w-5 mr-2 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </button>
              <button
                onClick={() => exportData('csv')}
                className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
              >
                <ArrowDownTrayIcon className="h-5 w-5 mr-2" />
                Export CSV
              </button>
              <button
                onClick={() => exportData('json')}
                className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
              >
                <ArrowDownTrayIcon className="h-5 w-5 mr-2" />
                Export JSON
              </button>
            </div>
          </div>

          {/* Controls */}
          <div className="bg-white shadow rounded-lg p-4 mb-6">
            <div className="flex flex-col space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between space-y-4 sm:space-y-0">
                <div className="flex space-x-2">
                  <button
                    onClick={() => setView('chart')}
                    className={`inline-flex items-center px-4 py-2 rounded-md text-sm font-medium ${
                      view === 'chart'
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                    }`}
                  >
                    <ChartBarIcon className="h-5 w-5 mr-2" />
                    Charts
                  </button>
                  <button
                    onClick={() => setView('table')}
                    className={`inline-flex items-center px-4 py-2 rounded-md text-sm font-medium ${
                      view === 'table'
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                    }`}
                  >
                    <TableCellsIcon className="h-5 w-5 mr-2" />
                    Table
                  </button>
                </div>

                <select
                  value={timeRange}
                  onChange={(e) => handleTimeRangeChange(e.target.value)}
                  className="block w-full sm:w-auto pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm rounded-md"
                >
                  <option value="1h">Last Hour</option>
                  <option value="24h">Last 24 Hours</option>
                  <option value="7d">Last 7 Days</option>
                  <option value="30d">Last 30 Days</option>
                  <option value="custom">Custom Range</option>
                </select>
              </div>

              {timeRange === 'custom' && (
                <div className="flex flex-col sm:flex-row sm:items-end space-y-4 sm:space-y-0 sm:space-x-4 pt-2 border-t border-gray-200">
                  <div className="flex-1">
                    <label htmlFor="startDate" className="block text-sm font-medium text-gray-700 mb-1">
                      Start Date
                    </label>
                    <input
                      type="date"
                      id="startDate"
                      value={customStartDate}
                      onChange={(e) => setCustomStartDate(e.target.value)}
                      className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                    />
                  </div>
                  <div className="flex-1">
                    <label htmlFor="endDate" className="block text-sm font-medium text-gray-700 mb-1">
                      End Date
                    </label>
                    <input
                      type="date"
                      id="endDate"
                      value={customEndDate}
                      onChange={(e) => setCustomEndDate(e.target.value)}
                      className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                    />
                  </div>
                  <button
                    onClick={handleCustomDateFetch}
                    disabled={!customStartDate || !customEndDate}
                    className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400 disabled:cursor-not-allowed"
                  >
                    Load Data
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Active drag-zoom selection — overrides the dropdown / custom
              dates until cleared. */}
          {selectedRange && (
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 bg-blue-50 border border-blue-200 rounded-md px-4 py-3 mb-4">
              <span className="text-sm text-blue-900">
                Showing selection:{' '}
                <span className="font-medium">
                  {format(selectedRange.start, 'MMM d, HH:mm:ss')}
                </span>{' '}
                →{' '}
                <span className="font-medium">
                  {format(selectedRange.end, 'MMM d, HH:mm:ss')}
                </span>
              </span>
              <button
                type="button"
                onClick={handleClearSelection}
                className="inline-flex items-center self-start sm:self-auto px-3 py-1.5 text-sm font-medium text-blue-700 hover:text-blue-900 hover:bg-blue-100 rounded-md"
              >
                <XMarkIcon className="h-4 w-4 mr-1" />
                Clear selection
              </button>
            </div>
          )}

          {/* Error banner — shown once a refresh actually fails. Auto-refresh
              keeps retrying on its interval, so the data isn't stuck. */}
          {error && (
            <div
              role="alert"
              className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4 mb-6"
            >
              Failed to load sensor data. Please try again.
            </div>
          )}

          {/* Coverage summary — confirms the charts/tables reflect the full window */}
          {!loading && !error && loadMeta && (
            <div className="text-sm text-gray-600 mb-4" data-testid="coverage-summary">
              {loadMeta.points > 0 ? (
                <>
                  Showing{' '}
                  <span className="font-medium text-gray-900">
                    {loadMeta.points.toLocaleString()}
                  </span>{' '}
                  data point{loadMeta.points === 1 ? '' : 's'}
                  {loadMeta.aggregation && (
                    <> · {AGGREGATE_LABEL[loadMeta.aggregation.interval]}</>
                  )}
                  {loadMeta.pages > 1 && <> · {loadMeta.pages} pages</>}
                  {loadMeta.truncated && (
                    <span className="text-amber-600">
                      {' '}
                      · range truncated (too many points)
                    </span>
                  )}
                </>
              ) : (
                <>No data in the selected range.</>
              )}
            </div>
          )}

          {loading || (!loadMeta && !error) ? (
            <div className="flex justify-center py-12" role="status" aria-label="Loading">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
            </div>
          ) : view === 'chart' ? (
            <div className="space-y-6">
              {/* Drag-to-zoom hint — only shown when there's data to drag on. */}
              {chartData.length > 0 && !selectedRange && (
                <p className="text-xs text-gray-500 -mb-2">
                  Tip: click and drag across any chart to zoom into a time range.
                </p>
              )}

              {/* Temperature & Humidity Chart */}
              <div className="bg-white p-6 rounded-lg shadow select-none">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Temperature & Humidity</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart
                    data={chartData}
                    onMouseDown={handleChartMouseDown}
                    onMouseMove={handleChartMouseMove}
                    onMouseUp={handleChartMouseUp}
                    onMouseLeave={handleChartMouseLeave}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="timestamp"
                      type="number"
                      domain={['dataMin', 'dataMax']}
                      scale="time"
                      tickFormatter={formatTick}
                      interval="preserveStartEnd"
                    />
                    <YAxis yAxisId="temp" orientation="left" />
                    <YAxis yAxisId="humidity" orientation="right" />
                    <Tooltip labelFormatter={(ts) => format(new Date(Number(ts)), 'MMM d, HH:mm:ss')} />
                    <Legend />
                    <Line
                      yAxisId="temp"
                      type="monotone"
                      dataKey="tempAvg"
                      stroke="#ef4444"
                      name="Temperature (°C)"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                    <Line
                      yAxisId="humidity"
                      type="monotone"
                      dataKey="humAvg"
                      stroke="#3b82f6"
                      name="Humidity (%)"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                    {dragStart != null && dragEnd != null && dragStart !== dragEnd && (
                      <ReferenceArea
                        yAxisId="temp"
                        x1={Math.min(dragStart, dragEnd)}
                        x2={Math.max(dragStart, dragEnd)}
                        strokeOpacity={0.3}
                        fill="#3b82f6"
                        fillOpacity={0.15}
                      />
                    )}
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Current Chart */}
              <div className="bg-white p-6 rounded-lg shadow select-none">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Current Consumption</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <AreaChart
                    data={chartData}
                    onMouseDown={handleChartMouseDown}
                    onMouseMove={handleChartMouseMove}
                    onMouseUp={handleChartMouseUp}
                    onMouseLeave={handleChartMouseLeave}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="timestamp"
                      type="number"
                      domain={['dataMin', 'dataMax']}
                      scale="time"
                      tickFormatter={formatTick}
                      interval="preserveStartEnd"
                    />
                    <YAxis />
                    <Tooltip labelFormatter={(ts) => format(new Date(Number(ts)), 'MMM d, HH:mm:ss')} />
                    <Legend />
                    <Area
                      type="monotone"
                      dataKey="current1RMS"
                      stackId="1"
                      stroke="#8b5cf6"
                      fill="#8b5cf6"
                      name="Current 1 RMS (A)"
                      fillOpacity={0.6}
                      isAnimationActive={false}
                    />
                    <Area
                      type="monotone"
                      dataKey="current2RMS"
                      stackId="1"
                      stroke="#10b981"
                      fill="#10b981"
                      name="Current 2 RMS (A)"
                      fillOpacity={0.6}
                      isAnimationActive={false}
                    />
                    {dragStart != null && dragEnd != null && dragStart !== dragEnd && (
                      <ReferenceArea
                        x1={Math.min(dragStart, dragEnd)}
                        x2={Math.max(dragStart, dragEnd)}
                        strokeOpacity={0.3}
                        fill="#3b82f6"
                        fillOpacity={0.15}
                      />
                    )}
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              {/* Pressure Chart */}
              <div className="bg-white p-6 rounded-lg shadow select-none">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Pressure</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart
                    data={chartData}
                    onMouseDown={handleChartMouseDown}
                    onMouseMove={handleChartMouseMove}
                    onMouseUp={handleChartMouseUp}
                    onMouseLeave={handleChartMouseLeave}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="timestamp"
                      type="number"
                      domain={['dataMin', 'dataMax']}
                      scale="time"
                      tickFormatter={formatTick}
                      interval="preserveStartEnd"
                    />
                    <YAxis />
                    <Tooltip labelFormatter={(ts) => format(new Date(Number(ts)), 'MMM d, HH:mm:ss')} />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="pressAvg"
                      stroke="#f59e0b"
                      name="Pressure (psi)"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                    {dragStart != null && dragEnd != null && dragStart !== dragEnd && (
                      <ReferenceArea
                        x1={Math.min(dragStart, dragEnd)}
                        x2={Math.max(dragStart, dragEnd)}
                        strokeOpacity={0.3}
                        fill="#3b82f6"
                        fillOpacity={0.15}
                      />
                    )}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          ) : (
            <div className="bg-white shadow rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Timestamp
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Temp (°C)
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Humidity (%)
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Pressure (psi)
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Current 1 (A)
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Current 2 (A)
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Duty Cycle 1 (%)
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Duty Cycle 2 (%)
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {data.map((row) => (
                      <tr key={row.id}>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {format(new Date(row.timestamp), 'yyyy-MM-dd HH:mm:ss')}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {row.tempAvg.toFixed(1)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {row.humAvg.toFixed(1)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {row.pressAvg.toFixed(2)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {row.current1RMS.toFixed(2)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {row.current2RMS.toFixed(2)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {(row.dutyCycle1 * 100).toFixed(1)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {(row.dutyCycle2 * 100).toFixed(1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </ProtectedRoute>
  )
}