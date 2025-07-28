'use client'

import { useState } from 'react'
import { useSession } from 'next-auth/react'
import {
  LockClosedIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
  XMarkIcon
} from '@heroicons/react/24/outline'

interface PasswordChangeProps {
  userId?: string
  isAdminChanging?: boolean
}

interface Message {
  type: 'success' | 'error'
  text: string
}

export default function PasswordChange({ userId, isAdminChanging = false }: PasswordChangeProps) {
  const { data: session } = useSession()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const targetUserId = userId || (session as { user: { id: string } } | null)?.user?.id

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setMessage(null)

    if (newPassword !== confirmPassword) {
      setMessage({ type: 'error', text: 'New passwords do not match' })
      return
    }

    if (newPassword.length < 8) {
      setMessage({ type: 'error', text: 'Password must be at least 8 characters long' })
      return
    }

    setLoading(true)

    try {
      const response = await fetch(`/api/users/${targetUserId}/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword,
          newPassword
        })
      })

      if (response.ok) {
        setMessage({ type: 'success', text: 'Password changed successfully' })
        setCurrentPassword('')
        setNewPassword('')
        setConfirmPassword('')
      } else {
        const error = await response.json()
        setMessage({ type: 'error', text: error.error || 'Failed to change password' })
      }
    } catch {
      setMessage({ type: 'error', text: 'Network error occurred' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-white shadow rounded-lg p-6">
      <div className="flex items-center mb-4">
        <LockClosedIcon className="h-6 w-6 text-gray-400 mr-2" />
        <h3 className="text-lg font-medium text-gray-900">
          {isAdminChanging ? 'Change User Password' : 'Change Password'}
        </h3>
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

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">
            {isAdminChanging ? 'Your Admin Password (required for verification)' : 'Current Password'}
          </label>
          <input
            type="password"
            required
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
            placeholder={isAdminChanging ? 'Enter your admin password' : 'Enter your current password'}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">New Password</label>
          <input
            type="password"
            required
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
            placeholder="Enter new password (min 8 characters)"
            minLength={8}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">Confirm New Password</label>
          <input
            type="password"
            required
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
            placeholder="Confirm new password"
          />
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={loading}
            className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
          >
            {loading ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                Changing...
              </>
            ) : (
              'Change Password'
            )}
          </button>
        </div>
      </form>
    </div>
  )
}