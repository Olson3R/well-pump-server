'use client'

import { ProtectedRoute } from '@/components/ProtectedRoute'
import { Navigation } from '@/components/Navigation'
import { useEffect, useState } from 'react'
import { 
  ExclamationTriangleIcon,
  CheckCircleIcon,
  SignalIcon,
  ClockIcon
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
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchLatestData()
    fetchActiveEvents()
    
    // Set up polling every 30 seconds
    const interval = setInterval(() => {
      fetchLatestData()
      fetchActiveEvents()
    }, 30000)

    return () => clearInterval(interval)
  }, [])

  const fetchLatestData = async () => {
    try {
      const response = await fetch('/api/sensors?limit=1')
      const result = await response.json()
      if (result.data && result.data.length > 0) {
        setLatestData(result.data[0])
      }
    } catch (error) {
      console.error('Error fetching latest data:', error)
    } finally {
      setLoading(false)
    }
  }

  const fetchActiveEvents = async () => {
    try {
      const response = await fetch('/api/events?active=true&limit=10')
      const result = await response.json()
      if (result.data) {
        setActiveEvents(result.data)
        setSystemStatus(result.data.length > 0 ? 'warning' : 'healthy')
      }
    } catch (error) {
      console.error('Error fetching active events:', error)
      setSystemStatus('error')
    }
  }

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
          </div>

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
                        Last Update
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

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Current Readings */}
            <div className="bg-white shadow rounded-lg">
              <div className="px-4 py-5 sm:p-6">
                <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">
                  Current Readings
                </h3>
                {loading ? (
                  <div className="flex justify-center py-4">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
                  </div>
                ) : latestData ? (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="border rounded-lg p-3">
                      <div className="text-sm font-medium text-gray-500">Temperature</div>
                      <div className="text-2xl font-bold text-gray-900">
                        {latestData.tempAvg.toFixed(1)}°C
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