import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function POST(request: NextRequest) {
  try {
    // This endpoint should be protected by API key or cron job
    const apiKey = request.headers.get('x-api-key')
    if (apiKey !== process.env.INTERNAL_API_KEY) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Get data retention setting
    const retentionSetting = await prisma.systemSettings.findUnique({
      where: { key: 'dataRetentionYears' }
    })
    
    const retentionYears = retentionSetting ? parseInt(retentionSetting.value) : 3
    const cutoffDate = new Date()
    cutoffDate.setFullYear(cutoffDate.getFullYear() - retentionYears)

    // Delete old sensor data
    const deletedSensorData = await prisma.sensorData.deleteMany({
      where: {
        timestamp: {
          lt: cutoffDate
        }
      }
    })

    // Delete old events (but keep for longer than sensor data for audit purposes)
    const eventCutoffDate = new Date()
    eventCutoffDate.setFullYear(eventCutoffDate.getFullYear() - (retentionYears + 1))
    
    const deletedEvents = await prisma.event.deleteMany({
      where: {
        timestamp: {
          lt: eventCutoffDate
        }
      }
    })

    // Log the cleanup operation
    await prisma.dataRetentionLog.create({
      data: {
        recordsDeleted: deletedSensorData.count + deletedEvents.count,
        retentionDays: retentionYears * 365,
        success: true
      }
    })

    return NextResponse.json({
      success: true,
      sensorDataDeleted: deletedSensorData.count,
      eventsDeleted: deletedEvents.count,
      retentionYears
    })

  } catch (error) {
    console.error('Error during data cleanup:', error)
    
    // Log the failed cleanup
    try {
      await prisma.dataRetentionLog.create({
        data: {
          recordsDeleted: 0,
          retentionDays: 0,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      })
    } catch (logError) {
      console.error('Error logging cleanup failure:', logError)
    }

    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}