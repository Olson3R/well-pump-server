import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import crypto from 'crypto'

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const sessionUser = session as { user: { id: string; role: string } }
    const { searchParams } = new URL(request.url)
    const userId = searchParams.get('userId')

    let whereClause = {}
    
    if (sessionUser.user.role === 'ADMIN' && userId) {
      // Admins can view tokens for any user
      whereClause = { userId }
    } else {
      // Regular users can only view their own tokens
      whereClause = { userId: sessionUser.user.id }
    }

    const tokens = await prisma.deviceToken.findMany({
      where: whereClause,
      select: {
        id: true,
        name: true,
        token: true,
        permissions: true,
        lastUsed: true,
        expiresAt: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        user: {
          select: {
            id: true,
            username: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    })

    return NextResponse.json(tokens)
  } catch (error) {
    console.error('Error fetching device tokens:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { name, permissions, expiresAt, userId } = await request.json()

    if (!name) {
      return NextResponse.json({ error: 'Token name is required' }, { status: 400 })
    }

    const sessionUser = session as { user: { id: string; role: string } }
    let targetUserId = sessionUser.user.id

    // Admins can create tokens for other users
    if (sessionUser.user.role === 'ADMIN' && userId) {
      targetUserId = userId
    }

    // Generate secure random token
    const token = crypto.randomBytes(32).toString('hex')

    // Create device token
    const deviceToken = await prisma.deviceToken.create({
      data: {
        name,
        token,
        userId: targetUserId,
        permissions: permissions || { sensors: true, events: true },
        expiresAt: expiresAt ? new Date(expiresAt) : undefined
      },
      select: {
        id: true,
        name: true,
        token: true,
        permissions: true,
        lastUsed: true,
        expiresAt: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        user: {
          select: {
            id: true,
            username: true
          }
        }
      }
    })

    return NextResponse.json(deviceToken, { status: 201 })
  } catch (error) {
    console.error('Error creating device token:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}