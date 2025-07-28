import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import bcrypt from 'bcryptjs'

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { currentPassword, newPassword } = await request.json()

    if (!currentPassword || !newPassword) {
      return NextResponse.json({ error: 'Current password and new password are required' }, { status: 400 })
    }

    const sessionUser = session as { user: { id: string; role: string } }
    const resolvedParams = await params
    const isAdmin = sessionUser.user.role === 'ADMIN'
    const isOwnAccount = sessionUser.user.id === resolvedParams.id

    // Users can only change their own password, unless they're admin
    if (!isAdmin && !isOwnAccount) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Get current user
    const user = await prisma.user.findUnique({
      where: { id: resolvedParams.id },
      select: { id: true, password: true }
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Verify current password (required even for admins changing other users' passwords)
    if (isAdmin && !isOwnAccount) {
      // For admins changing other users' passwords, verify admin's password
      const adminUser = await prisma.user.findUnique({
        where: { id: sessionUser.user.id },
        select: { password: true }
      })
      if (!adminUser || !(await bcrypt.compare(currentPassword, adminUser.password))) {
        return NextResponse.json({ error: 'Invalid admin password' }, { status: 400 })
      }
    } else {
      // For users changing their own password
      if (!(await bcrypt.compare(currentPassword, user.password))) {
        return NextResponse.json({ error: 'Invalid current password' }, { status: 400 })
      }
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 12)

    // Update password
    await prisma.user.update({
      where: { id: resolvedParams.id },
      data: { password: hashedPassword }
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error changing password:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}