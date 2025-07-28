import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { name, permissions, expiresAt, isActive } = await request.json()
    const sessionUser = session as { user: { id: string; role: string } }
    const resolvedParams = await params

    // Get the token to check ownership
    const existingToken = await prisma.deviceToken.findUnique({
      where: { id: resolvedParams.id },
      select: { userId: true }
    })

    if (!existingToken) {
      return NextResponse.json({ error: 'Token not found' }, { status: 404 })
    }

    // Users can only modify their own tokens, unless they're admin
    if (sessionUser.user.role !== 'ADMIN' && existingToken.userId !== sessionUser.user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const updateData: {
      name?: string
      permissions?: object
      expiresAt?: Date | null
      isActive?: boolean
    } = {}

    if (name) updateData.name = name
    if (permissions) updateData.permissions = permissions
    if (expiresAt !== undefined) {
      updateData.expiresAt = expiresAt ? new Date(expiresAt) : null
    }
    if (isActive !== undefined) updateData.isActive = isActive

    const token = await prisma.deviceToken.update({
      where: { id: resolvedParams.id },
      data: updateData,
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

    return NextResponse.json(token)
  } catch (error) {
    console.error('Error updating device token:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const sessionUser = session as { user: { id: string; role: string } }
    const resolvedParams = await params

    // Get the token to check ownership
    const existingToken = await prisma.deviceToken.findUnique({
      where: { id: resolvedParams.id },
      select: { userId: true }
    })

    if (!existingToken) {
      return NextResponse.json({ error: 'Token not found' }, { status: 404 })
    }

    // Users can only delete their own tokens, unless they're admin
    if (sessionUser.user.role !== 'ADMIN' && existingToken.userId !== sessionUser.user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    await prisma.deviceToken.delete({
      where: { id: resolvedParams.id }
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error deleting device token:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}