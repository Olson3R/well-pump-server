import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    
    if (!session) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const { subscription } = await request.json()
    
    if (!subscription || !subscription.endpoint) {
      return NextResponse.json(
        { error: 'Invalid subscription data' },
        { status: 400 }
      )
    }

    // Update user's push notification settings
    await prisma.notificationSettings.upsert({
      where: { userId: session.user.id },
      update: {
        pushEnabled: true,
        pushEndpoint: subscription.endpoint,
        pushKeys: subscription.keys
      },
      create: {
        userId: session.user.id,
        pushEnabled: true,
        pushEndpoint: subscription.endpoint,
        pushKeys: subscription.keys,
        pushoverEnabled: false,
        highCurrentAlert: true,
        lowPressureAlert: true,
        lowTemperatureAlert: true,
        sensorErrorAlert: true,
        missingDataAlert: true
      }
    })

    return NextResponse.json({
      success: true,
      message: 'Push notifications enabled'
    })

  } catch (error) {
    console.error('Error subscribing to push notifications:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    
    if (!session) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Disable push notifications
    await prisma.notificationSettings.update({
      where: { userId: session.user.id },
      data: {
        pushEnabled: false,
        pushEndpoint: null,
        pushKeys: null
      }
    })

    return NextResponse.json({
      success: true,
      message: 'Push notifications disabled'
    })

  } catch (error) {
    console.error('Error unsubscribing from push notifications:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}