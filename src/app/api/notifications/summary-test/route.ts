import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import {
  sendSummaryReportFor,
  type SummaryReportPeriod,
} from '@/lib/summary-report'

/**
 * POST /api/notifications/summary-test
 *
 * Immediately build and deliver the summary report to the calling user's
 * Pushover destination, ignoring schedule/idempotency. Backs the "Send test
 * now" button on the settings page so a user can verify their configuration
 * without waiting for the next scheduled tick.
 *
 * Body (optional): { period: 'day' | 'week' } — defaults to whatever the user
 * has saved in their settings.
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions)
  const userId = (session as { user?: { id?: string } } | null)?.user?.id
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let period: SummaryReportPeriod | undefined
  try {
    const body = await request.json().catch(() => ({}))
    if (body && (body.period === 'day' || body.period === 'week')) {
      period = body.period
    }
  } catch {
    // Empty/invalid body just means "use saved period".
  }

  try {
    const result = await sendSummaryReportFor(userId, { period })
    if (!result.delivered) {
      return NextResponse.json(
        {
          delivered: false,
          reason: result.skippedReason ?? result.channel?.error ?? 'send failed',
        },
        { status: 422 },
      )
    }
    return NextResponse.json({ delivered: true, period: result.period })
  } catch (error) {
    console.error('Error sending summary report:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
