import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export interface AuthContext {
  isAuthenticated: boolean
  user?: {
    id: string
    username: string
    role: string
  }
  deviceToken?: {
    id: string
    name: string
    permissions: Record<string, boolean>
    userId: string
  }
  authMethod: 'session' | 'device-token' | 'none'
}

export async function getAuthContext(request: NextRequest): Promise<AuthContext> {
  // Try session authentication first
  const session = await getServerSession(authOptions)
  if (session) {
    const sessionUser = session as { user: { id: string; username: string; role: string } }
    return {
      isAuthenticated: true,
      user: sessionUser.user,
      authMethod: 'session'
    }
  }

  // Try device token authentication
  const authHeader = request.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7)
    
    const deviceToken = await prisma.deviceToken.findUnique({
      where: { 
        token,
        isActive: true
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            role: true
          }
        }
      }
    })

    if (deviceToken && (!deviceToken.expiresAt || deviceToken.expiresAt > new Date())) {
      // Update last used timestamp
      await prisma.deviceToken.update({
        where: { id: deviceToken.id },
        data: { lastUsed: new Date() }
      })

      return {
        isAuthenticated: true,
        user: deviceToken.user,
        deviceToken: {
          id: deviceToken.id,
          name: deviceToken.name,
          permissions: deviceToken.permissions as Record<string, boolean>,
          userId: deviceToken.userId
        },
        authMethod: 'device-token'
      }
    }
  }

  return {
    isAuthenticated: false,
    authMethod: 'none'
  }
}

export function hasPermission(
  authContext: AuthContext,
  permission: string,
  requiredRole?: 'ADMIN' | 'VIEWER'
): boolean {
  if (!authContext.isAuthenticated || !authContext.user) {
    return false
  }

  // Check role requirement
  if (requiredRole && authContext.user.role !== requiredRole && authContext.user.role !== 'ADMIN') {
    return false
  }

  // For session auth, check user role
  if (authContext.authMethod === 'session') {
    return authContext.user.role === 'ADMIN' || authContext.user.role === 'VIEWER'
  }

  // For device token auth, check specific permission
  if (authContext.authMethod === 'device-token' && authContext.deviceToken) {
    return authContext.deviceToken.permissions[permission] === true
  }

  return false
}