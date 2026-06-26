import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import {
  sendPushover,
  getEnvPushoverCredentials,
  validateNotificationConfig,
  type PushoverCredentials,
} from '@/lib/notifications'

/**
 * GET — report current notification configuration (does not send anything).
 * Lets the UI/operator confirm whether Pushover/web-push are configured.
 */
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const config = validateNotificationConfig()
  return NextResponse.json({ config })
}

/**
 * POST — send a real test Pushover notification so delivery can be verified
 * end-to-end. Credential resolution order:
 *   1. token/user supplied in the request body
 *   2. the signed-in user's saved Pushover settings
 *   3. the PUSHOVER_TOKEN / PUSHOVER_USER environment variables
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const userId = (session as { user: { id: string } }).user.id

    let body: { token?: string; user?: string; message?: string } = {}
    try {
      body = await request.json()
    } catch {
      /* empty body is fine */
    }

    let credentials: PushoverCredentials | null = null
    let source = 'request'

    if (body.token && body.user) {
      credentials = { token: body.token.trim(), user: body.user.trim() }
    } else {
      const settings = await prisma.notificationSettings.findUnique({
        where: { userId },
      })
      if (settings?.pushoverToken && settings?.pushoverUser) {
        credentials = {
          token: settings.pushoverToken,
          user: settings.pushoverUser,
        }
        source = 'user-settings'
      } else {
        credentials = getEnvPushoverCredentials()
        source = 'env'
      }
    }

    if (!credentials) {
      return NextResponse.json(
        {
          error:
            'No Pushover credentials available. Provide token/user, save them ' +
            'in settings, or set PUSHOVER_TOKEN / PUSHOVER_USER.',
        },
        { status: 400 }
      )
    }

    const result = await sendPushover(
      credentials,
      {
        eventType: 'SYSTEM_TEST',
        title: 'Well Pump Monitor — Test',
        body:
          body.message ||
          'This is a test notification. If you received this, Pushover delivery is working.',
      },
      `test:${source}`
    )

    return NextResponse.json(
      { success: result.success, source, result },
      { status: result.success ? 200 : 502 }
    )
  } catch (error) {
    console.error('Error sending test notification:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
