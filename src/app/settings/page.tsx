'use client'

import { ProtectedRoute } from '@/components/ProtectedRoute'
import { Navigation } from '@/components/Navigation'
import UserManagement from '@/components/UserManagement'
import PasswordChange from '@/components/PasswordChange'
import DeviceTokens from '@/components/DeviceTokens'
import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import {
  BellIcon,
  UserIcon,
  CogIcon,
  KeyIcon,
  LockClosedIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
  TrashIcon
} from '@heroicons/react/24/outline'

interface NotificationSettings {
  pushEnabled: boolean
  pushoverEnabled: boolean
  pushoverToken?: string
  pushoverUser?: string
  highCurrentAlert: boolean
  lowPressureAlert: boolean
  lowTemperatureAlert: boolean
  sensorErrorAlert: boolean
  missingDataAlert: boolean
}

interface CleanupLog {
  id: string
  runAt: string
  recordsDeleted: number
  retentionDays: number
  success: boolean
  error?: string
}

export default function SettingsPage() {
  const { data: session } = useSession()
  const [activeTab, setActiveTab] = useState('notifications')
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings | null>(null)
  const [systemSettings, setSystemSettings] = useState<Record<string, string | number | boolean>>({})
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null)
  const [cleanupLogs, setCleanupLogs] = useState<CleanupLog[]>([])
  const [cleaningUp, setCleaningUp] = useState(false)

  const sessionUser = session as { user: { role: string } } | null
  const isAdmin = (sessionUser?.user as { role?: string })?.role === 'ADMIN'

  useEffect(() => {
    fetchNotificationSettings()
    fetchSystemSettings()
  }, [])

  useEffect(() => {
    if (activeTab === 'system' && isAdmin) {
      fetchCleanupLogs()
    }
  }, [activeTab, isAdmin])

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

  const fetchSystemSettings = async () => {
    try {
      const response = await fetch('/api/settings')
      if (response.ok) {
        const data = await response.json()
        setSystemSettings(data)
      }
    } catch (error) {
      console.error('Error fetching system settings:', error)
    }
  }

  const fetchCleanupLogs = async () => {
    try {
      const response = await fetch('/api/maintenance/cleanup')
      if (response.ok) {
        const data = await response.json()
        setCleanupLogs(data)
      }
    } catch (error) {
      console.error('Error fetching cleanup logs:', error)
    }
  }

  const triggerCleanup = async () => {
    setCleaningUp(true)
    setMessage(null)

    try {
      const response = await fetch('/api/maintenance/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retentionMonths: 2 })
      })

      const data = await response.json()

      if (response.ok && data.success) {
        setMessage({
          type: 'success',
          text: `Cleanup completed: ${data.sensorDataDeleted} sensor records and ${data.eventsDeleted} events deleted`
        })
        fetchCleanupLogs()
      } else {
        throw new Error(data.error || 'Cleanup failed')
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Error running cleanup'
      })
    } finally {
      setCleaningUp(false)
    }
  }

  const saveNotificationSettings = async () => {
    setSaving(true)
    setMessage(null)
    
    try {
      const response = await fetch('/api/notifications/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notificationSettings)
      })
      
      if (response.ok) {
        setMessage({ type: 'success', text: 'Notification settings saved successfully' })
      } else {
        throw new Error('Failed to save settings')
      }
    } catch {
      setMessage({ type: 'error', text: 'Error saving notification settings' })
    } finally {
      setSaving(false)
    }
  }

  const requestNotificationPermission = async () => {
    if ('Notification' in window && 'serviceWorker' in navigator) {
      const permission = await Notification.requestPermission()
      
      if (permission === 'granted') {
        const registration = await navigator.serviceWorker.ready
        
        // Get VAPID public key from server
        const response = await fetch('/api/notifications/vapid-key')
        const { publicKey } = await response.json()
        
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: publicKey
        })
        
        // Send subscription to server
        await fetch('/api/notifications/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription })
        })
        
        setNotificationSettings(prev => prev ? { ...prev, pushEnabled: true } : null)
        setMessage({ type: 'success', text: 'Push notifications enabled' })
      }
    }
  }

  const tabs = [
    { id: 'notifications', name: 'Notifications', icon: BellIcon },
    { id: 'password', name: 'Password', icon: LockClosedIcon },
    { id: 'tokens', name: 'Device Tokens', icon: KeyIcon },
    ...(isAdmin ? [
      { id: 'users', name: 'Users', icon: UserIcon },
      { id: 'system', name: 'System', icon: CogIcon }
    ] : [])
  ]

  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-gray-50">
        <Navigation />
        
        <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
          <div className="md:flex md:items-center md:justify-between mb-6">
            <div className="flex-1 min-w-0">
              <h2 className="text-2xl font-bold leading-7 text-gray-900 sm:text-3xl sm:truncate">
                Settings
              </h2>
            </div>
          </div>

          {/* Tabs */}
          <div className="border-b border-gray-200 mb-6">
            <nav className="-mb-px flex space-x-8">
              {tabs.map((tab) => {
                const Icon = tab.icon
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`py-2 px-1 inline-flex items-center border-b-2 font-medium text-sm ${
                      activeTab === tab.id
                        ? 'border-blue-500 text-blue-600'
                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }`}
                  >
                    <Icon className="h-5 w-5 mr-2" />
                    {tab.name}
                  </button>
                )
              })}
            </nav>
          </div>

          {/* Message */}
          {message && (
            <div className={`mb-4 rounded-md p-4 ${
              message.type === 'success' ? 'bg-green-50' : 'bg-red-50'
            }`}>
              <div className="flex">
                <div className="flex-shrink-0">
                  {message.type === 'success' ? (
                    <CheckCircleIcon className="h-5 w-5 text-green-400" />
                  ) : (
                    <ExclamationTriangleIcon className="h-5 w-5 text-red-400" />
                  )}
                </div>
                <div className="ml-3">
                  <p className={`text-sm font-medium ${
                    message.type === 'success' ? 'text-green-800' : 'text-red-800'
                  }`}>
                    {message.text}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Content */}
          {activeTab === 'notifications' && notificationSettings && (
            <div className="bg-white shadow rounded-lg">
              <div className="px-4 py-5 sm:p-6">
                <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">
                  Notification Settings
                </h3>
                
                {/* Push Notifications */}
                <div className="space-y-4 mb-6">
                  <h4 className="text-sm font-medium text-gray-900">Push Notifications</h4>
                  <div className="flex items-center justify-between">
                    <span className="flex-grow flex flex-col">
                      <span className="text-sm font-medium text-gray-900">
                        Browser Push Notifications
                      </span>
                      <span className="text-sm text-gray-500">
                        Receive alerts in your browser
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        if (!notificationSettings.pushEnabled) {
                          requestNotificationPermission()
                        } else {
                          setNotificationSettings({ ...notificationSettings, pushEnabled: false })
                        }
                      }}
                      className={`${
                        notificationSettings.pushEnabled ? 'bg-blue-600' : 'bg-gray-200'
                      } relative inline-flex flex-shrink-0 h-6 w-11 border-2 border-transparent rounded-full cursor-pointer transition-colors ease-in-out duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500`}
                    >
                      <span
                        className={`${
                          notificationSettings.pushEnabled ? 'translate-x-5' : 'translate-x-0'
                        } pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform ring-0 transition ease-in-out duration-200`}
                      />
                    </button>
                  </div>
                </div>

                {/* Pushover */}
                <div className="space-y-4 mb-6">
                  <h4 className="text-sm font-medium text-gray-900">Pushover Notifications</h4>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Pushover User Key
                    </label>
                    <input
                      type="text"
                      value={notificationSettings.pushoverUser || ''}
                      onChange={(e) => setNotificationSettings({
                        ...notificationSettings,
                        pushoverUser: e.target.value
                      })}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                      placeholder="Your Pushover user key"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Pushover API Token
                    </label>
                    <input
                      type="text"
                      value={notificationSettings.pushoverToken || ''}
                      onChange={(e) => setNotificationSettings({
                        ...notificationSettings,
                        pushoverToken: e.target.value
                      })}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                      placeholder="Your Pushover API token"
                    />
                  </div>
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      checked={notificationSettings.pushoverEnabled}
                      onChange={(e) => setNotificationSettings({
                        ...notificationSettings,
                        pushoverEnabled: e.target.checked
                      })}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <label className="ml-2 block text-sm text-gray-900">
                      Enable Pushover notifications
                    </label>
                  </div>
                </div>

                {/* Alert Types */}
                <div className="space-y-4 mb-6">
                  <h4 className="text-sm font-medium text-gray-900">Alert Types</h4>
                  <div className="space-y-2">
                    {[
                      { key: 'highCurrentAlert', label: 'High Current Alerts' },
                      { key: 'lowPressureAlert', label: 'Low Pressure Alerts' },
                      { key: 'lowTemperatureAlert', label: 'Low Temperature Alerts' },
                      { key: 'sensorErrorAlert', label: 'Sensor Error Alerts' },
                      { key: 'missingDataAlert', label: 'Missing Data Alerts' }
                    ].map((alert) => (
                      <div key={alert.key} className="flex items-center">
                        <input
                          type="checkbox"
                          checked={notificationSettings[alert.key as keyof NotificationSettings] as boolean}
                          onChange={(e) => setNotificationSettings({
                            ...notificationSettings,
                            [alert.key]: e.target.checked
                          })}
                          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                        />
                        <label className="ml-2 block text-sm text-gray-900">
                          {alert.label}
                        </label>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mt-6">
                  <button
                    onClick={saveNotificationSettings}
                    disabled={saving}
                    className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
                  >
                    {saving ? 'Saving...' : 'Save Settings'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'password' && <PasswordChange />}

          {activeTab === 'tokens' && <DeviceTokens />}

          {isAdmin && activeTab === 'users' && <UserManagement />}

          {isAdmin && activeTab === 'system' && (
            <div className="space-y-6">
              {/* Data Retention Settings */}
              <div className="bg-white shadow rounded-lg">
                <div className="px-4 py-5 sm:p-6">
                  <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">
                    System Settings
                  </h3>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700">
                        Data Retention Period (years)
                      </label>
                      <input
                        type="number"
                        value={Number(systemSettings.dataRetentionYears) || 3}
                        onChange={(e) => setSystemSettings({
                          ...systemSettings,
                          dataRetentionYears: parseInt(e.target.value)
                        })}
                        min="1"
                        max="10"
                        className="mt-1 block w-32 border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                      />
                      <p className="mt-1 text-sm text-gray-500">
                        Automatically delete data older than this period
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Data Cleanup */}
              <div className="bg-white shadow rounded-lg">
                <div className="px-4 py-5 sm:p-6">
                  <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">
                    Data Cleanup
                  </h3>
                  <p className="text-sm text-gray-500 mb-4">
                    Delete sensor data and resolved events older than 2 months. This runs automatically every day at 2:00 AM.
                  </p>
                  <button
                    onClick={triggerCleanup}
                    disabled={cleaningUp}
                    className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50"
                  >
                    <TrashIcon className="h-4 w-4 mr-2" />
                    {cleaningUp ? 'Cleaning up...' : 'Run Cleanup Now'}
                  </button>

                  {/* Cleanup Logs */}
                  {cleanupLogs.length > 0 && (
                    <div className="mt-6">
                      <h4 className="text-sm font-medium text-gray-900 mb-2">Recent Cleanup History</h4>
                      <div className="overflow-hidden border border-gray-200 rounded-md">
                        <table className="min-w-full divide-y divide-gray-200">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Records Deleted</th>
                              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                            </tr>
                          </thead>
                          <tbody className="bg-white divide-y divide-gray-200">
                            {cleanupLogs.map((log) => (
                              <tr key={log.id}>
                                <td className="px-4 py-2 text-sm text-gray-900">
                                  {new Date(log.runAt).toLocaleString()}
                                </td>
                                <td className="px-4 py-2 text-sm text-gray-900">
                                  {log.recordsDeleted}
                                </td>
                                <td className="px-4 py-2 text-sm">
                                  {log.success ? (
                                    <span className="inline-flex items-center text-green-600">
                                      <CheckCircleIcon className="h-4 w-4 mr-1" />
                                      Success
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center text-red-600" title={log.error}>
                                      <ExclamationTriangleIcon className="h-4 w-4 mr-1" />
                                      Failed
                                    </span>
                                  )}
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
            </div>
          )}
        </div>
      </div>
    </ProtectedRoute>
  )
}