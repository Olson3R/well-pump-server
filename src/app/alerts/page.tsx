'use client'

import { ProtectedRoute } from '@/components/ProtectedRoute'
import { Navigation } from '@/components/Navigation'
import { useState, useEffect, useCallback } from 'react'
import { format } from 'date-fns'
import {
  ExclamationTriangleIcon,
  CheckCircleIcon,
  BellIcon,
  BellSlashIcon
} from '@heroicons/react/24/outline'
import { useSession } from 'next-auth/react'

interface Event {
  id: string
  type: string
  description: string
  value: number
  threshold: number
  active: boolean
  timestamp: string
  duration: string
  acknowledged: boolean
  acknowledgedAt?: string
  acknowledgedBy?: string
}

const eventTypeColors = {
  HIGH_CURRENT: 'border-red-400 bg-red-50',
  LOW_PRESSURE: 'border-yellow-400 bg-yellow-50',
  LOW_TEMPERATURE: 'border-blue-400 bg-blue-50',
  SENSOR_ERROR: 'border-purple-400 bg-purple-50',
  SYSTEM_ERROR: 'border-gray-400 bg-gray-50',
  MISSING_DATA: 'border-orange-400 bg-orange-50'
}

const eventTypeIcons = {
  HIGH_CURRENT: '⚡',
  LOW_PRESSURE: '💧',
  LOW_TEMPERATURE: '❄️',
  SENSOR_ERROR: '🔧',
  SYSTEM_ERROR: '⚠️',
  MISSING_DATA: '📡'
}

export default function AlertsPage() {
  const { data: session } = useSession()
  const [events, setEvents] = useState<Event[]>([])
  const [filter, setFilter] = useState<'all' | 'active' | 'acknowledged'>('all')
  const [loading, setLoading] = useState(true)
  const [notificationSettings, setNotificationSettings] = useState<{
    email?: boolean
    sms?: boolean
    push?: boolean
    pushEnabled?: boolean
  } | null>(null)

  const fetchEvents = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (filter === 'active') params.append('active', 'true')
      else if (filter === 'acknowledged') params.append('acknowledged', 'true')
      
      const response = await fetch(`/api/events?${params}&limit=100`)
      const result = await response.json()
      
      if (result.data) {
        setEvents(result.data)
      }
    } catch (error) {
      console.error('Error fetching events:', error)
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    fetchEvents()
    fetchNotificationSettings()
    
    // Auto-refresh every 30 seconds
    const interval = setInterval(fetchEvents, 30000)
    return () => clearInterval(interval)
  }, [fetchEvents])

  const fetchNotificationSettings = async () => {
    try {
      const response = await fetch('/api/notifications/settings')
      if (response.ok) {
        const data = await response.json()
        setNotificationSettings(data)
      }
    } catch (error) {
      console.error('Error fetching notification settings:', error)
    }
  }

  const acknowledgeEvent = async (eventId: string) => {
    try {
      const response = await fetch(`/api/events?id=${eventId}&action=acknowledge`, {
        method: 'PATCH'
      })
      
      if (response.ok) {
        fetchEvents()
      }
    } catch (error) {
      console.error('Error acknowledging event:', error)
    }
  }

  const formatDuration = (duration: string) => {
    const ms = parseInt(duration)
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    
    if (hours > 0) return `${hours}h ${minutes % 60}m`
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`
    return `${seconds}s`
  }

  const activeCount = events.filter(e => e.active).length
  const acknowledgedCount = events.filter(e => e.acknowledged).length

  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-gray-50">
        <Navigation />
        
        <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
          {/* Header */}
          <div className="md:flex md:items-center md:justify-between mb-6">
            <div className="flex-1 min-w-0">
              <h2 className="text-2xl font-bold leading-7 text-gray-900 sm:text-3xl sm:truncate">
                Alerts & Events
              </h2>
            </div>
            <div className="mt-4 flex md:mt-0 md:ml-4">
              {notificationSettings?.pushEnabled ? (
                <div className="flex items-center text-sm text-green-600">
                  <BellIcon className="h-5 w-5 mr-1" />
                  Notifications Enabled
                </div>
              ) : (
                <div className="flex items-center text-sm text-gray-500">
                  <BellSlashIcon className="h-5 w-5 mr-1" />
                  Notifications Disabled
                </div>
              )}
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div className="bg-white overflow-hidden shadow rounded-lg">
              <div className="p-5">
                <div className="flex items-center">
                  <div className="flex-shrink-0">
                    <ExclamationTriangleIcon className="h-8 w-8 text-red-600" />
                  </div>
                  <div className="ml-5 w-0 flex-1">
                    <dl>
                      <dt className="text-sm font-medium text-gray-500 truncate">
                        Active Alerts
                      </dt>
                      <dd className="text-lg font-medium text-gray-900">
                        {activeCount}
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
                    <CheckCircleIcon className="h-8 w-8 text-green-600" />
                  </div>
                  <div className="ml-5 w-0 flex-1">
                    <dl>
                      <dt className="text-sm font-medium text-gray-500 truncate">
                        Acknowledged
                      </dt>
                      <dd className="text-lg font-medium text-gray-900">
                        {acknowledgedCount}
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
                    <BellIcon className="h-8 w-8 text-blue-600" />
                  </div>
                  <div className="ml-5 w-0 flex-1">
                    <dl>
                      <dt className="text-sm font-medium text-gray-500 truncate">
                        Total Events
                      </dt>
                      <dd className="text-lg font-medium text-gray-900">
                        {events.length}
                      </dd>
                    </dl>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Filter */}
          <div className="bg-white shadow rounded-lg p-4 mb-6">
            <div className="flex space-x-4">
              <button
                onClick={() => setFilter('all')}
                className={`px-4 py-2 rounded-md text-sm font-medium ${
                  filter === 'all'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                All Events
              </button>
              <button
                onClick={() => setFilter('active')}
                className={`px-4 py-2 rounded-md text-sm font-medium ${
                  filter === 'active'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                Active Only
              </button>
              <button
                onClick={() => setFilter('acknowledged')}
                className={`px-4 py-2 rounded-md text-sm font-medium ${
                  filter === 'acknowledged'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                Acknowledged
              </button>
            </div>
          </div>

          {/* Events List */}
          <div className="bg-white shadow rounded-lg overflow-hidden">
            {loading ? (
              <div className="flex justify-center py-12">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
              </div>
            ) : events.length === 0 ? (
              <div className="text-center py-12">
                <BellSlashIcon className="mx-auto h-12 w-12 text-gray-400" />
                <h3 className="mt-2 text-sm font-medium text-gray-900">No events</h3>
                <p className="mt-1 text-sm text-gray-500">
                  No events found matching your filter criteria.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-gray-200">
                {events.map((event) => (
                  <li key={event.id} className={`p-6 ${eventTypeColors[event.type as keyof typeof eventTypeColors] || 'bg-gray-50'}`}>
                    <div className="flex items-start">
                      <div className="flex-shrink-0 text-2xl">
                        {eventTypeIcons[event.type as keyof typeof eventTypeIcons] || '⚠️'}
                      </div>
                      <div className="ml-4 flex-1">
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-medium text-gray-900">
                            {event.description}
                          </p>
                          <div className="ml-2 flex-shrink-0 flex">
                            {event.active && (
                              <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-red-100 text-red-800">
                                Active
                              </span>
                            )}
                            {event.acknowledged && (
                              <span className="ml-2 px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 text-green-800">
                                Acknowledged
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="mt-2 sm:flex sm:justify-between">
                          <div className="sm:flex sm:space-x-4">
                            <p className="flex items-center text-sm text-gray-500">
                              Value: {event.value.toFixed(2)} / Threshold: {event.threshold.toFixed(2)}
                            </p>
                            <p className="mt-2 flex items-center text-sm text-gray-500 sm:mt-0">
                              Duration: {formatDuration(event.duration)}
                            </p>
                          </div>
                          <div className="mt-2 flex items-center text-sm text-gray-500 sm:mt-0">
                            <p>
                              {format(new Date(event.timestamp), 'MMM d, yyyy HH:mm:ss')}
                            </p>
                          </div>
                        </div>
                        {event.acknowledged && event.acknowledgedAt && (
                          <p className="mt-2 text-sm text-gray-500">
                            Acknowledged by {event.acknowledgedBy} at {format(new Date(event.acknowledgedAt), 'MMM d, HH:mm')}
                          </p>
                        )}
                        {event.active && !event.acknowledged && (session?.user as { role?: string })?.role === 'ADMIN' && (
                          <div className="mt-4">
                            <button
                              onClick={() => acknowledgeEvent(event.id)}
                              className="inline-flex items-center px-3 py-2 border border-transparent text-sm leading-4 font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                            >
                              Acknowledge
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </ProtectedRoute>
  )
}