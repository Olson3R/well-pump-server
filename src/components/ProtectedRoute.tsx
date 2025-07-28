'use client'

import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

interface ProtectedRouteProps {
  children: React.ReactNode
  requiredRole?: 'ADMIN' | 'VIEWER'
}

export function ProtectedRoute({ children, requiredRole = 'VIEWER' }: ProtectedRouteProps) {
  const { data: session, status } = useSession()
  const router = useRouter()

  useEffect(() => {
    if (status === 'loading') return

    if (!session) {
      router.push('/auth/signin')
      return
    }

    if (requiredRole === 'ADMIN' && (session?.user as { role?: string })?.role !== 'ADMIN') {
      router.push('/unauthorized')
      return
    }
  }, [session, status, router, requiredRole])

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-500"></div>
      </div>
    )
  }

  if (!session) {
    return null
  }

  if (requiredRole === 'ADMIN' && (session?.user as { role?: string })?.role !== 'ADMIN') {
    return null
  }

  return <>{children}</>
}