import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { cleanupOldData, getCleanupLogs } from '@/lib/cleanup'

// POST - Trigger data cleanup (admin only or API key)
export async function POST(request: NextRequest) {
  try {
    // Check for API key auth (for external triggers)
    const apiKey = request.headers.get('x-api-key')
    const isApiKeyAuth = apiKey === process.env.INTERNAL_API_KEY

    // Check for session auth (for UI triggers)
    let isAdminAuth = false
    if (!isApiKeyAuth) {
      const session = await getServerSession(authOptions)
      const sessionUser = session?.user as { role?: string } | undefined
      isAdminAuth = sessionUser?.role === 'ADMIN'
    }

    if (!isApiKeyAuth && !isAdminAuth) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Default to 2 months retention, but allow override via request body
    let retentionMonths = 2
    try {
      const body = await request.json()
      if (body.retentionMonths && typeof body.retentionMonths === 'number') {
        retentionMonths = body.retentionMonths
      }
    } catch {
      // No body or invalid JSON, use default
    }

    const result = await cleanupOldData(retentionMonths)

    if (result.success) {
      return NextResponse.json(result)
    } else {
      return NextResponse.json(
        { error: result.error },
        { status: 500 }
      )
    }
  } catch (error) {
    console.error('Error during data cleanup:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// GET - Fetch cleanup logs (admin only)
export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    const sessionUser = session?.user as { role?: string } | undefined

    if (sessionUser?.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const logs = await getCleanupLogs(10)
    return NextResponse.json(logs)
  } catch (error) {
    console.error('Error fetching cleanup logs:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}