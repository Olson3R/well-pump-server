'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import {
  KeyIcon,
  PlusIcon,
  TrashIcon,
  ClipboardDocumentIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
  XMarkIcon,
  EyeIcon,
  EyeSlashIcon
} from '@heroicons/react/24/outline'

interface DeviceToken {
  id: string
  name: string
  token: string
  permissions: Record<string, boolean>
  lastUsed?: string
  expiresAt?: string
  isActive: boolean
  createdAt: string
  user: {
    id: string
    username: string
  }
}

interface TokenFormData {
  name: string
  permissions: Record<string, boolean>
  expiresAt: string
  userId?: string
}

interface Message {
  type: 'success' | 'error'
  text: string
}

interface DeviceTokensProps {
  userId?: string
}

export default function DeviceTokens({ userId }: DeviceTokensProps) {
  const { data: session } = useSession()
  const [tokens, setTokens] = useState<DeviceToken[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<Message | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [showTokens, setShowTokens] = useState<Record<string, boolean>>({})
  const [formData, setFormData] = useState<TokenFormData>({
    name: '',
    permissions: { sensors: true, events: true },
    expiresAt: '',
    userId: userId
  })

  const sessionUser = session as { user: { id: string; role: string } } | null
  const isAdmin = (sessionUser?.user as { role?: string })?.role === 'ADMIN'

  const fetchTokens = useCallback(async () => {
    try {
      const url = userId ? `/api/device-tokens?userId=${userId}` : '/api/device-tokens'
      const response = await fetch(url)
      if (response.ok) {
        const data = await response.json()
        setTokens(data)
      } else {
        setMessage({ type: 'error', text: 'Failed to fetch device tokens' })
      }
    } catch {
      setMessage({ type: 'error', text: 'Error fetching device tokens' })
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    fetchTokens()
  }, [fetchTokens])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setMessage(null)

    try {
      const body = {
        ...formData,
        expiresAt: formData.expiresAt || undefined
      }

      const response = await fetch('/api/device-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })

      if (response.ok) {
        const newToken = await response.json()
        setMessage({ type: 'success', text: 'Device token created successfully' })
        fetchTokens()
        setShowCreateForm(false)
        setFormData({
          name: '',
          permissions: { sensors: true, events: true },
          expiresAt: '',
          userId: userId
        })
        
        // Show the new token
        setShowTokens(prev => ({ ...prev, [newToken.id]: true }))
      } else {
        const error = await response.json()
        setMessage({ type: 'error', text: error.error || 'Failed to create token' })
      }
    } catch {
      setMessage({ type: 'error', text: 'Network error occurred' })
    }
  }

  const handleDelete = async (tokenId: string) => {
    if (!confirm('Are you sure you want to delete this device token?')) return

    try {
      const response = await fetch(`/api/device-tokens/${tokenId}`, {
        method: 'DELETE'
      })

      if (response.ok) {
        setMessage({ type: 'success', text: 'Device token deleted successfully' })
        fetchTokens()
      } else {
        const error = await response.json()
        setMessage({ type: 'error', text: error.error || 'Failed to delete token' })
      }
    } catch {
      setMessage({ type: 'error', text: 'Error deleting token' })
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    setMessage({ type: 'success', text: 'Token copied to clipboard' })
  }

  const toggleTokenVisibility = (tokenId: string) => {
    setShowTokens(prev => ({ ...prev, [tokenId]: !prev[tokenId] }))
  }

  const getPermissionsList = (permissions: Record<string, boolean>) => {
    return Object.entries(permissions)
      .filter(([, enabled]) => enabled)
      .map(([permission]) => permission)
      .join(', ')
  }

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-medium text-gray-900">Device Tokens</h3>
        <button
          onClick={() => setShowCreateForm(true)}
          className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700"
        >
          <PlusIcon className="h-4 w-4 mr-2" />
          Create Token
        </button>
      </div>

      {/* Message */}
      {message && (
        <div className={`rounded-md p-4 ${
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
            <div className="ml-auto pl-3">
              <button
                onClick={() => setMessage(null)}
                className={`inline-flex rounded-md p-1.5 ${
                  message.type === 'success' 
                    ? 'text-green-500 hover:bg-green-100' 
                    : 'text-red-500 hover:bg-red-100'
                }`}
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Form */}
      {showCreateForm && (
        <div className="bg-white shadow rounded-lg p-6">
          <h4 className="text-lg font-medium text-gray-900 mb-4">Create Device Token</h4>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">Token Name *</label>
              <input
                type="text"
                required
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="e.g., ESP32 Sensor Device"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Permissions</label>
              <div className="space-y-2">
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={formData.permissions.sensors}
                    onChange={(e) => setFormData({ 
                      ...formData, 
                      permissions: { ...formData.permissions, sensors: e.target.checked }
                    })}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <label className="ml-2 block text-sm text-gray-900">
                    Sensors (POST/GET sensor data)
                  </label>
                </div>
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={formData.permissions.events}
                    onChange={(e) => setFormData({ 
                      ...formData, 
                      permissions: { ...formData.permissions, events: e.target.checked }
                    })}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <label className="ml-2 block text-sm text-gray-900">
                    Events (POST/GET event data)
                  </label>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">Expiration Date (optional)</label>
              <input
                type="datetime-local"
                value={formData.expiresAt}
                onChange={(e) => setFormData({ ...formData, expiresAt: e.target.value })}
                className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
              />
            </div>

            <div className="flex justify-end space-x-3">
              <button
                type="button"
                onClick={() => setShowCreateForm(false)}
                className="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700"
              >
                Create Token
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Tokens List */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        {tokens.length === 0 ? (
          <div className="p-6 text-center text-gray-500">
            No device tokens found. Create one to get started.
          </div>
        ) : (
          <div className="divide-y divide-gray-200">
            {tokens.map((token) => (
              <div key={token.id} className="p-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center">
                    <KeyIcon className="h-8 w-8 text-gray-400" />
                    <div className="ml-4">
                      <div className="text-sm font-medium text-gray-900">{token.name}</div>
                      {isAdmin && (
                        <div className="text-sm text-gray-500">User: {token.user.username}</div>
                      )}
                      <div className="text-xs text-gray-500">
                        Permissions: {getPermissionsList(token.permissions)}
                      </div>
                      <div className="text-xs text-gray-500">
                        Created: {new Date(token.createdAt).toLocaleDateString()}
                        {token.lastUsed && (
                          <span> • Last used: {new Date(token.lastUsed).toLocaleDateString()}</span>
                        )}
                        {token.expiresAt && (
                          <span> • Expires: {new Date(token.expiresAt).toLocaleDateString()}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                      token.isActive ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                    }`}>
                      {token.isActive ? 'Active' : 'Inactive'}
                    </span>
                    <button
                      onClick={() => handleDelete(token.id)}
                      className="text-red-600 hover:text-red-900"
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                
                <div className="mt-4 flex items-center space-x-2">
                  <div className="flex-1 bg-gray-50 rounded-md p-2">
                    <code className="text-xs font-mono">
                      {showTokens[token.id] ? token.token : '••••••••••••••••••••••••••••••••'}
                    </code>
                  </div>
                  <button
                    onClick={() => toggleTokenVisibility(token.id)}
                    className="p-2 text-gray-400 hover:text-gray-600"
                  >
                    {showTokens[token.id] ? (
                      <EyeSlashIcon className="h-4 w-4" />
                    ) : (
                      <EyeIcon className="h-4 w-4" />
                    )}
                  </button>
                  <button
                    onClick={() => copyToClipboard(token.token)}
                    className="p-2 text-gray-400 hover:text-gray-600"
                  >
                    <ClipboardDocumentIcon className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}