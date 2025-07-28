'use client'

import { useState, useEffect } from 'react'
import {
  UserIcon,
  PencilIcon,
  TrashIcon,
  PlusIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
  XMarkIcon
} from '@heroicons/react/24/outline'

interface User {
  id: string
  username: string
  email?: string
  role: 'ADMIN' | 'VIEWER'
  createdAt: string
  updatedAt: string
  lastLoginAt?: string
  _count?: {
    deviceTokens: number
  }
}

interface UserFormData {
  username: string
  email: string
  password: string
  role: 'ADMIN' | 'VIEWER'
}

interface Message {
  type: 'success' | 'error'
  text: string
}

export default function UserManagement() {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<Message | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [editingUser, setEditingUser] = useState<User | null>(null)
  const [formData, setFormData] = useState<UserFormData>({
    username: '',
    email: '',
    password: '',
    role: 'VIEWER'
  })

  useEffect(() => {
    fetchUsers()
  }, [])

  const fetchUsers = async () => {
    try {
      const response = await fetch('/api/users')
      if (response.ok) {
        const data = await response.json()
        setUsers(data)
      } else {
        setMessage({ type: 'error', text: 'Failed to fetch users' })
      }
    } catch {
      setMessage({ type: 'error', text: 'Error fetching users' })
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setMessage(null)

    try {
      const url = editingUser ? `/api/users/${editingUser.id}` : '/api/users'
      const method = editingUser ? 'PUT' : 'POST'
      
      const body: Partial<UserFormData> = {
        username: formData.username,
        email: formData.email || undefined,
        role: formData.role
      }

      if (!editingUser || formData.password) {
        body.password = formData.password
      }

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })

      if (response.ok) {
        setMessage({ 
          type: 'success', 
          text: editingUser ? 'User updated successfully' : 'User created successfully' 
        })
        fetchUsers()
        resetForm()
      } else {
        const error = await response.json()
        setMessage({ type: 'error', text: error.error || 'Operation failed' })
      }
    } catch {
      setMessage({ type: 'error', text: 'Network error occurred' })
    }
  }

  const handleDelete = async (userId: string) => {
    if (!confirm('Are you sure you want to delete this user?')) return

    try {
      const response = await fetch(`/api/users/${userId}`, {
        method: 'DELETE'
      })

      if (response.ok) {
        setMessage({ type: 'success', text: 'User deleted successfully' })
        fetchUsers()
      } else {
        const error = await response.json()
        setMessage({ type: 'error', text: error.error || 'Failed to delete user' })
      }
    } catch {
      setMessage({ type: 'error', text: 'Error deleting user' })
    }
  }

  const resetForm = () => {
    setFormData({ username: '', email: '', password: '', role: 'VIEWER' })
    setShowCreateForm(false)
    setEditingUser(null)
  }

  const startEdit = (user: User) => {
    setEditingUser(user)
    setFormData({
      username: user.username,
      email: user.email || '',
      password: '',
      role: user.role
    })
    setShowCreateForm(true)
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
        <h3 className="text-lg font-medium text-gray-900">User Management</h3>
        <button
          onClick={() => setShowCreateForm(true)}
          className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700"
        >
          <PlusIcon className="h-4 w-4 mr-2" />
          Add User
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

      {/* Create/Edit Form */}
      {showCreateForm && (
        <div className="bg-white shadow rounded-lg p-6">
          <h4 className="text-lg font-medium text-gray-900 mb-4">
            {editingUser ? 'Edit User' : 'Create New User'}
          </h4>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Username *</label>
                <input
                  type="text"
                  required
                  value={formData.username}
                  onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                  className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Email</label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">
                  Password {editingUser ? '(leave blank to keep current)' : '*'}
                </label>
                <input
                  type="password"
                  required={!editingUser}
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Role</label>
                <select
                  value={formData.role}
                  onChange={(e) => setFormData({ ...formData, role: e.target.value as 'ADMIN' | 'VIEWER' })}
                  className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                >
                  <option value="VIEWER">Viewer</option>
                  <option value="ADMIN">Admin</option>
                </select>
              </div>
            </div>
            <div className="flex justify-end space-x-3">
              <button
                type="button"
                onClick={resetForm}
                className="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700"
              >
                {editingUser ? 'Update User' : 'Create User'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Users Table */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                User
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Role
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Tokens
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Last Login
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {users.map((user) => (
              <tr key={user.id}>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex items-center">
                    <UserIcon className="h-8 w-8 text-gray-400" />
                    <div className="ml-4">
                      <div className="text-sm font-medium text-gray-900">{user.username}</div>
                      {user.email && <div className="text-sm text-gray-500">{user.email}</div>}
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                    user.role === 'ADMIN' 
                      ? 'bg-purple-100 text-purple-800' 
                      : 'bg-green-100 text-green-800'
                  }`}>
                    {user.role}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                  {user._count?.deviceTokens || 0}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  {user.lastLoginAt 
                    ? new Date(user.lastLoginAt).toLocaleDateString()
                    : 'Never'
                  }
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                  <div className="flex space-x-2">
                    <button
                      onClick={() => startEdit(user)}
                      className="text-blue-600 hover:text-blue-900"
                    >
                      <PencilIcon className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(user.id)}
                      className="text-red-600 hover:text-red-900"
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}