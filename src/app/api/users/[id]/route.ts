import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { UserRole } from '@prisma/client'
import bcrypt from 'bcryptjs'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    
    if (!session || (session as { user: { role: string } }).user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const resolvedParams = await params
    const user = await prisma.user.findUnique({
      where: { id: resolvedParams.id },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        createdAt: true,
        updatedAt: true,
        lastLoginAt: true,
        deviceTokens: {
          select: {
            id: true,
            name: true,
            lastUsed: true,
            expiresAt: true,
            isActive: true,
            createdAt: true
          }
        }
      }
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    return NextResponse.json(user)
  } catch (error) {
    console.error('Error fetching user:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    
    if (!session || (session as { user: { role: string } }).user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { username, email, role, password } = await request.json()
    const resolvedParams = await params

    const updateData: {
      username?: string
      email?: string | null
      role?: UserRole
      password?: string
    } = {}

    if (username) updateData.username = username
    if (email !== undefined) updateData.email = email || null
    if (role && ['ADMIN', 'VIEWER'].includes(role)) updateData.role = role as UserRole
    if (password) {
      updateData.password = await bcrypt.hash(password, 12)
    }

    const user = await prisma.user.update({
      where: { id: resolvedParams.id },
      data: updateData,
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        createdAt: true,
        updatedAt: true,
        lastLoginAt: true
      }
    })

    return NextResponse.json(user)
  } catch (error) {
    console.error('Error updating user:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    
    if (!session || (session as { user: { role: string } }).user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const resolvedParams = await params

    // Don't allow deleting yourself
    if ((session as { user: { id: string } }).user.id === resolvedParams.id) {
      return NextResponse.json({ error: 'Cannot delete your own account' }, { status: 400 })
    }

    await prisma.user.delete({
      where: { id: resolvedParams.id }
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error deleting user:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}