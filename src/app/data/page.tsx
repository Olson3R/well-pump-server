'use client'

import { ProtectedRoute } from '@/components/ProtectedRoute'
import { Navigation } from '@/components/Navigation'
import { useState, useEffect } from 'react'
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
  ResponsiveContainer
} from 'recharts'
import { format } from 'date-fns'
import {
  ArrowDownTrayIcon,
  ChartBarIcon,
  TableCellsIcon
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

export default function DataPage() {
  const [data, setData] = useState<SensorData[]>([])
  const [view, setView] = useState<'table' | 'chart'>('chart')
  const [timeRange, setTimeRange] = useState('24h')
  const [loading, setLoading] = useState(true)
  const [customStartDate, setCustomStartDate] = useState('')
  const [customEndDate, setCustomEndDate] = useState('')
  const [dateRangeSpan, setDateRangeSpan] = useState(1) // days

  useEffect(() => {
    if (timeRange !== 'custom') {
      fetchData()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeRange])

  const fetchData = async (customStart?: string, customEnd?: string) => {
    setLoading(true)
    try {
      let startDate: Date
      let endDate: Date
      let aggregate = ''

      if (timeRange === 'custom' && customStart && customEnd) {
        startDate = new Date(customStart)
        endDate = new Date(customEnd)
        // Set end date to end of day
        endDate.setHours(23, 59, 59, 999)
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

      // Calculate span in days for custom ranges
      const spanMs = endDate.getTime() - startDate.getTime()
      const spanDays = spanMs / (1000 * 60 * 60 * 24)
      setDateRangeSpan(spanDays)

      // Smart aggregation for custom date ranges
      if (timeRange === 'custom') {
        if (spanDays > 7) {
          aggregate = '6hour' // > 7 days: aggregate by 6 hours
        } else if (spanDays > 1) {
          aggregate = 'hour' // > 1 day: aggregate by hour
        }
        // <= 1 day: no aggregation (raw data)
      }

      let url = `/api/sensors?startDate=${startDate.toISOString()}&endDate=${endDate.toISOString()}`
      if (aggregate) {
        url += `&aggregate=${aggregate}`
      }

      const response = await fetch(url)
      const result = await response.json()

      if (result.data) {
        setData(result.data.reverse()) // Reverse to show oldest first for charts
      }
    } catch (error) {
      console.error('Error fetching data:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleCustomDateFetch = () => {
    if (customStartDate && customEndDate) {
      fetchData(customStartDate, customEndDate)
    }
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

  const formatData = () => {
    // Choose date format based on time range span
    let dateFormat = 'HH:mm'
    if (timeRange === '7d' || (timeRange === 'custom' && dateRangeSpan > 1 && dateRangeSpan <= 7)) {
      dateFormat = 'EEE HH:mm' // e.g., "Mon 14:00"
    } else if (timeRange === '30d' || (timeRange === 'custom' && dateRangeSpan > 7)) {
      dateFormat = 'MMM d' // e.g., "Jan 15"
    }

    return data.map(d => ({
      ...d,
      timestamp: new Date(d.timestamp).getTime(),
      formattedTime: format(new Date(d.timestamp), dateFormat)
    }))
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
                Sensor Data
              </h2>
            </div>
            <div className="mt-4 flex md:mt-0 md:ml-4 space-x-2">
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
                  onChange={(e) => setTimeRange(e.target.value)}
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

          {loading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
            </div>
          ) : view === 'chart' ? (
            <div className="space-y-6">
              {/* Temperature & Humidity Chart */}
              <div className="bg-white p-6 rounded-lg shadow">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Temperature & Humidity</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={formatData()}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis 
                      dataKey="formattedTime"
                      interval="preserveStartEnd"
                    />
                    <YAxis yAxisId="temp" orientation="left" />
                    <YAxis yAxisId="humidity" orientation="right" />
                    <Tooltip />
                    <Legend />
                    <Line
                      yAxisId="temp"
                      type="monotone"
                      dataKey="tempAvg"
                      stroke="#ef4444"
                      name="Temperature (°C)"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      yAxisId="humidity"
                      type="monotone"
                      dataKey="humAvg"
                      stroke="#3b82f6"
                      name="Humidity (%)"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Current Chart */}
              <div className="bg-white p-6 rounded-lg shadow">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Current Consumption</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <AreaChart data={formatData()}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis 
                      dataKey="formattedTime"
                      interval="preserveStartEnd"
                    />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Area
                      type="monotone"
                      dataKey="current1RMS"
                      stackId="1"
                      stroke="#8b5cf6"
                      fill="#8b5cf6"
                      name="Current 1 RMS (A)"
                      fillOpacity={0.6}
                    />
                    <Area
                      type="monotone"
                      dataKey="current2RMS"
                      stackId="1"
                      stroke="#10b981"
                      fill="#10b981"
                      name="Current 2 RMS (A)"
                      fillOpacity={0.6}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              {/* Pressure Chart */}
              <div className="bg-white p-6 rounded-lg shadow">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Pressure</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={formatData()}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis 
                      dataKey="formattedTime"
                      interval="preserveStartEnd"
                    />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="pressAvg"
                      stroke="#f59e0b"
                      name="Pressure (psi)"
                      strokeWidth={2}
                      dot={false}
                    />
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