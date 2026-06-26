import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { isValidTimezone } from '@/lib/summary-report'

export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    
    if (!session) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const settings = await prisma.notificationSettings.findUnique({
      where: { userId: (session as { user: { id: string } }).user.id }
    })

    if (!settings) {
      // Create default settings if none exist. The summary-report fields rely
      // on the column-level defaults declared in the Prisma schema so they're
      // not repeated here.
      const newSettings = await prisma.notificationSettings.create({
        data: {
          userId: (session as { user: { id: string } }).user.id,
          pushEnabled: true,
          pushoverEnabled: false,
          highCurrentAlert: true,
          lowPressureAlert: true,
          lowTemperatureAlert: true,
          sensorErrorAlert: true,
          missingDataAlert: true,
          longRunAlert: true,
          pressureDropAlert: true,
        },
      })
      return NextResponse.json(newSettings)
    }

    return NextResponse.json(settings)
  } catch (error) {
    console.error('Error fetching notification settings:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    
    if (!session) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const data = await request.json()

    // Validate summary-report fields when present so a bad save can't silently
    // corrupt the schedule into something the cron will refuse to fire on.
    if ('summaryReportHourLocal' in data) {
      const hour = Number(data.summaryReportHourLocal)
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        return NextResponse.json(
          { error: 'summaryReportHourLocal must be an integer between 0 and 23' },
          { status: 400 },
        )
      }
      data.summaryReportHourLocal = hour
    }
    if ('summaryReportPeriod' in data && data.summaryReportPeriod !== 'day' && data.summaryReportPeriod !== 'week') {
      return NextResponse.json(
        { error: "summaryReportPeriod must be 'day' or 'week'" },
        { status: 400 },
      )
    }
    if ('summaryReportTimezone' in data && !isValidTimezone(data.summaryReportTimezone)) {
      return NextResponse.json(
        { error: 'summaryReportTimezone must be a valid IANA timezone' },
        { status: 400 },
      )
    }
    if (
      'temperatureUnit' in data &&
      data.temperatureUnit !== 'C' &&
      data.temperatureUnit !== 'F'
    ) {
      return NextResponse.json(
        { error: "temperatureUnit must be 'C' or 'F'" },
        { status: 400 },
      )
    }

    const settings = await prisma.notificationSettings.upsert({
      where: { userId: (session as { user: { id: string } }).user.id },
      update: data,
      create: {
        ...data,
        userId: (session as { user: { id: string } }).user.id
      }
    })

    return NextResponse.json(settings)
  } catch (error) {
    console.error('Error updating notification settings:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}