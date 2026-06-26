'use client'

import { ProtectedRoute } from '@/components/ProtectedRoute'
import { Navigation } from '@/components/Navigation'
import { LastUpdated } from '@/components/LastUpdated'
import { StatsSummary } from '@/components/StatsSummary'
import { useAutoRefresh } from '@/hooks/useAutoRefresh'
import { useTemperatureUnit } from '@/hooks/useTemperatureUnit'
import { formatTemperature } from '@/lib/temperature'
import { useCallback, useState } from 'react'
import {
  ExclamationTriangleIcon,
  CheckCircleIcon,
  SignalIcon,
  ClockIcon,
  ArrowPathIcon
} from '@heroicons/react/24/outline'

interface SensorData {
  id: string
  device: string
  location: string
  timestamp: string
  tempAvg: number
  current1Avg: number
  current2Avg: number
  pressAvg: number
  humAvg: number
}

interface Event {
  id: string
  type: string
  description: string
  active: boolean
  timestamp: string
}

export default function Dashboard() {
  const [latestData, setLatestData] = useState<SensorData | null>(null)
  const [activeEvents, setActiveEvents] = useState<Event[]>([])
  const [systemStatus, setSystemStatus] = useState<'healthy' | 'warning' | 'error'>('healthy')
  const temperatureUnit = useTemperatureUnit()

  /**
   * Single refresh pass for the whole dashboard: pull the latest reading and
   * the active events together. Both fetches share the {@link AbortSignal} so an
   * unmount (or a superseding refresh) cancels them cleanly. Throwing on failure
   * lets {@link useAutoRefresh} surface the error and keeps `lastUpdated`
   * pinned to the last *successful* load.
   */
  const refreshDashboard = useCallback(async (signal: AbortSignal) => {
    try {
      const [sensorRes, eventsRes] = await Promise.all([
        fetch('/api/sensors?limit=1', { signal, cache: 'no-store' }),
        fetch('/api/events?active=true&limit=10', { signal, cache: 'no-store' }),
      ])

      if (!sensorRes.ok) {
        throw new Error(`Sensors request failed (${sensorRes.status})`)
      }
      if (!eventsRes.ok) {
        throw new Error(`Events request failed (${eventsRes.status})`)
      }

      const [sensorResult, eventsResult] = await Promise.all([
        sensorRes.json(),
        eventsRes.json(),
      ])

      const reading: SensorData | null =
        Array.isArray(sensorResult.data) && sensorResult.data.length > 0
          ? sensorResult.data[0]
          : null
      const events: Event[] = Array.isArray(eventsResult.data)
        ? eventsResult.data
        : []

      setLatestData(reading)
      setActiveEvents(events)
      setSystemStatus(events.length > 0 ? 'warning' : 'healthy')
    } catch (err) {
      // Ignore deliberate cancellations; only real failures flip the status.
      if (signal.aborted) return
      console.error('Error refreshing dashboard:', err)
      setSystemStatus('error')
      throw err
    }
  }, [])

  const { loading, lastUpdated, error, isPaused, refresh } = useAutoRefresh(
    refreshDashboard,
    { intervalMs: 60_000 }
  )

  const getStatusColor = () => {
    switch (systemStatus) {
      case 'healthy': return 'text-green-600 bg-green-100'
      case 'warning': return 'text-yellow-600 bg-yellow-100'
      case 'error': return 'text-red-600 bg-red-100'
    }
  }

  const getStatusIcon = () => {
    switch (systemStatus) {
      case 'healthy': return CheckCircleIcon
      case 'warning': return ExclamationTriangleIcon
      case 'error': return ExclamationTriangleIcon
    }
  }

  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-gray-50">
        <Navigation />
        
        <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
          {/* Header */}
          <div className="md:flex md:items-center md:justify-between mb-6">
            <div className="flex-1 min-w-0">
              <h2 className="text-2xl font-bold leading-7 text-gray-900 sm:text-3xl sm:truncate">
                Dashboard
              </h2>
              <p className="mt-1 text-sm text-gray-500">
                Real-time well pump monitoring and status
              </p>
            </div>
            <div className="mt-4 flex items-center md:mt-0 md:ml-4 space-x-4">
              <LastUpdated
                date={lastUpdated}
                loading={loading}
                isPaused={isPaused}
              />
              <button
                onClick={() => { void refresh() }}
                disabled={loading}
                className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Refresh dashboard"
              >
                <ArrowPathIcon className={`h-5 w-5 mr-2 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>
          </div>

          {/* Error banner — only shown once a refresh has actually failed. */}
          {error && (
            <div
              role="alert"
              className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4 mb-6"
            >
              Failed to update dashboard data. Retrying automatically…
            </div>
          )}

          {/* Status Overview */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-white overflow-hidden shadow rounded-lg">
              <div className="p-5">
                <div className="flex items-center">
                  <div className="flex-shrink-0">
                    {(() => {
                      const StatusIcon = getStatusIcon()
                      return <StatusIcon className={`h-8 w-8 ${getStatusColor()}`} />
                    })()}
                  </div>
                  <div className="ml-5 w-0 flex-1">
                    <dl>
                      <dt className="text-sm font-medium text-gray-500 truncate">
                        System Status
                      </dt>
                      <dd className={`text-lg font-medium capitalize ${getStatusColor()}`}>
                        {systemStatus}
                      </dd>
                    </dl>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white overflow-hidden shadow rounded-lg">
              <div className="p-5">
                <div className="flex items-center">
                  <div className="flex-shrink-0">
                    <SignalIcon className="h-8 w-8 text-blue-600" />
                  </div>
                  <div className="ml-5 w-0 flex-1">
                    <dl>
                      <dt className="text-sm font-medium text-gray-500 truncate">
                        Active Alerts
                      </dt>
                      <dd className="text-lg font-medium text-gray-900">
                        {activeEvents.length}
                      </dd>
                    </dl>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white overflow-hidden shadow rounded-lg">
              <div className="p-5">
                <div className="flex items-center">
                  <div className="flex-shrink-0">
                    <ClockIcon className="h-8 w-8 text-green-600" />
                  </div>
                  <div className="ml-5 w-0 flex-1">
                    <dl>
                      <dt className="text-sm font-medium text-gray-500 truncate">
                        Last Reading
                      </dt>
                      <dd className="text-lg font-medium text-gray-900">
                        {latestData ? new Date(latestData.timestamp).toLocaleTimeString() : 'N/A'}
                      </dd>
                    </dl>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white overflow-hidden shadow rounded-lg">
              <div className="p-5">
                <div className="flex items-center">
                  <div className="flex-shrink-0">
                    <SignalIcon className="h-8 w-8 text-purple-600" />
                  </div>
                  <div className="ml-5 w-0 flex-1">
                    <dl>
                      <dt className="text-sm font-medium text-gray-500 truncate">
                        Device
                      </dt>
                      <dd className="text-lg font-medium text-gray-900">
                        {latestData?.device || 'N/A'}
                      </dd>
                    </dl>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Aggregated operational stats (own range selector + auto-refresh) */}
          <StatsSummary className="mb-6" />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Current Readings */}
            <div className="bg-white shadow rounded-lg">
              <div className="px-4 py-5 sm:p-6">
                <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">
                  Current Readings
                </h3>
                {loading && !latestData ? (
                  <div
                    className="flex justify-center py-4"
                    role="status"
                    aria-label="Loading current readings"
                  >
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
                  </div>
                ) : latestData ? (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="border rounded-lg p-3">
                      <div className="text-sm font-medium text-gray-500">Temperature</div>
                      <div className="text-2xl font-bold text-gray-900">
                        {formatTemperature(latestData.tempAvg, temperatureUnit)}
                      </div>
                    </div>
                    <div className="border rounded-lg p-3">
                      <div className="text-sm font-medium text-gray-500">Pressure</div>
                      <div className="text-2xl font-bold text-gray-900">
                        {latestData.pressAvg.toFixed(2)} psi
                      </div>
                    </div>
                    <div className="border rounded-lg p-3">
                      <div className="text-sm font-medium text-gray-500">Current 1</div>
                      <div className="text-2xl font-bold text-gray-900">
                        {latestData.current1Avg.toFixed(2)} A
                      </div>
                    </div>
                    <div className="border rounded-lg p-3">
                      <div className="text-sm font-medium text-gray-500">Current 2</div>
                      <div className="text-2xl font-bold text-gray-900">
                        {latestData.current2Avg.toFixed(2)} A
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-4 text-gray-500">
                    No data available
                  </div>
                )}
              </div>
            </div>

            {/* Active Alerts */}
            <div className="bg-white shadow rounded-lg">
              <div className="px-4 py-5 sm:p-6">
                <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">
                  Active Alerts
                </h3>
                {activeEvents.length > 0 ? (
                  <div className="space-y-3">
                    {activeEvents.map((event) => (
                      <div key={event.id} className="border-l-4 border-red-400 bg-red-50 p-4">
                        <div className="flex">
                          <div className="flex-shrink-0">
                            <ExclamationTriangleIcon className="h-5 w-5 text-red-400" />
                          </div>
                          <div className="ml-3">
                            <p className="text-sm text-red-700">{event.description}</p>
                            <p className="text-xs text-red-500 mt-1">
                              {new Date(event.timestamp).toLocaleString()}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-4">
                    <CheckCircleIcon className="mx-auto h-12 w-12 text-green-400" />
                    <p className="mt-2 text-sm text-gray-500">No active alerts</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </ProtectedRoute>
  )
}