import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import webpush from 'web-push'

// Configure web-push with VAPID details
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:admin@wellpump.local',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  )
}

export async function POST(request: NextRequest) {
  try {
    // This endpoint should be protected by API key or internal-only access
    const apiKey = request.headers.get('x-api-key')
    if (apiKey !== process.env.INTERNAL_API_KEY) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const { eventType, title, body, data } = await request.json()

    // Get all users with push notifications enabled for this event type
    const notificationSettings = await prisma.notificationSettings.findMany({
      where: {
        pushEnabled: true,
        pushEndpoint: { not: null },
        ...(eventType === 'HIGH_CURRENT' && { highCurrentAlert: true }),
        ...(eventType === 'LOW_PRESSURE' && { lowPressureAlert: true }),
        ...(eventType === 'LOW_TEMPERATURE' && { lowTemperatureAlert: true }),
        ...(eventType === 'SENSOR_ERROR' && { sensorErrorAlert: true }),
        ...(eventType === 'MISSING_DATA' && { missingDataAlert: true })
      },
      include: { user: true }
    })

    // Send push notifications
    const notifications = notificationSettings.map(async (settings) => {
      if (!settings.pushEndpoint || !settings.pushKeys) return

      const pushSubscription = {
        endpoint: settings.pushEndpoint,
        keys: settings.pushKeys as any
      }

      try {
        await webpush.sendNotification(
          pushSubscription,
          JSON.stringify({
            title,
            body,
            icon: '/icons/icon-192x192.png',
            badge: '/icons/icon-72x72.png',
            data: {
              ...data,
              url: '/alerts'
            }
          })
        )
      } catch (error) {
        console.error('Error sending push notification:', error)
        // If push fails, disable it for this user
        if ((error as any).statusCode === 410) {
          await prisma.notificationSettings.update({
            where: { id: settings.id },
            data: {
              pushEnabled: false,
              pushEndpoint: null,
              pushKeys: null
            }
          })
        }
      }
    })

    // Send Pushover notifications
    const pushoverSettings = await prisma.notificationSettings.findMany({
      where: {
        pushoverEnabled: true,
        pushoverToken: { not: null },
        pushoverUser: { not: null },
        ...(eventType === 'HIGH_CURRENT' && { highCurrentAlert: true }),
        ...(eventType === 'LOW_PRESSURE' && { lowPressureAlert: true }),
        ...(eventType === 'LOW_TEMPERATURE' && { lowTemperatureAlert: true }),
        ...(eventType === 'SENSOR_ERROR' && { sensorErrorAlert: true }),
        ...(eventType === 'MISSING_DATA' && { missingDataAlert: true })
      }
    })

    const pushoverNotifications = pushoverSettings.map(async (settings) => {
      if (!settings.pushoverToken || !settings.pushoverUser) return

      try {
        const response = await fetch('https://api.pushover.net/1/messages.json', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            token: settings.pushoverToken,
            user: settings.pushoverUser,
            title,
            message: body,
            priority: eventType === 'SENSOR_ERROR' || eventType === 'SYSTEM_ERROR' ? 1 : 0,
            url: `${process.env.NEXTAUTH_URL}/alerts`,
            url_title: 'View Alerts'
          })
        })

        if (!response.ok) {
          console.error('Pushover API error:', await response.text())
        }
      } catch (error) {
        console.error('Error sending Pushover notification:', error)
      }
    })

    await Promise.all([...notifications, ...pushoverNotifications])

    return NextResponse.json({
      success: true,
      notificationsSent: notificationSettings.length + pushoverSettings.length
    })

  } catch (error) {
    console.error('Error sending notifications:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}