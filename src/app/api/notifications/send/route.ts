import { NextRequest, NextResponse } from 'next/server'
import { dispatchNotifications } from '@/lib/notifications'

/**
 * Internal endpoint to dispatch a notification across all channels (web-push +
 * Pushover). Protected by the internal API key. The actual sending logic lives
 * in `@/lib/notifications` so it can be shared with the event-ingestion path.
 */
export async function POST(request: NextRequest) {
  try {
    const apiKey = request.headers.get('x-api-key')
    if (apiKey !== process.env.INTERNAL_API_KEY) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { eventType, title, body, data } = await request.json()

    if (!eventType || !title || !body) {
      return NextResponse.json(
        { error: 'eventType, title and body are required' },
        { status: 400 }
      )
    }

    const summary = await dispatchNotifications({ eventType, title, body, data })

    return NextResponse.json({
      success: true,
      notificationsSent: summary.succeeded,
      summary,
    })
  } catch (error) {
    console.error('Error sending notifications:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
