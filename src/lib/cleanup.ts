import { prisma } from './prisma'

export interface CleanupResult {
  success: boolean
  sensorDataDeleted: number
  eventsDeleted: number
  retentionMonths: number
  error?: string
}

/**
 * Clean up sensor data and events older than the specified number of months
 * Events are kept 1 month longer than sensor data for audit purposes
 */
export async function cleanupOldData(retentionMonths: number = 2): Promise<CleanupResult> {
  try {
    // Calculate cutoff date for sensor data
    const sensorCutoffDate = new Date()
    sensorCutoffDate.setMonth(sensorCutoffDate.getMonth() - retentionMonths)

    // Calculate cutoff date for events (keep 1 extra month for audit)
    const eventCutoffDate = new Date()
    eventCutoffDate.setMonth(eventCutoffDate.getMonth() - (retentionMonths + 1))

    // Delete old sensor data
    const deletedSensorData = await prisma.sensorData.deleteMany({
      where: {
        timestamp: {
          lt: sensorCutoffDate
        }
      }
    })

    // Delete old events (only resolved/inactive ones)
    const deletedEvents = await prisma.event.deleteMany({
      where: {
        timestamp: {
          lt: eventCutoffDate
        },
        active: false
      }
    })

    // Log the cleanup operation
    await prisma.dataRetentionLog.create({
      data: {
        recordsDeleted: deletedSensorData.count + deletedEvents.count,
        retentionDays: retentionMonths * 30,
        success: true
      }
    })

    console.log(`[Cleanup] Deleted ${deletedSensorData.count} sensor records and ${deletedEvents.count} events older than ${retentionMonths} months`)

    return {
      success: true,
      sensorDataDeleted: deletedSensorData.count,
      eventsDeleted: deletedEvents.count,
      retentionMonths
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    console.error('[Cleanup] Error during data cleanup:', error)

    // Log the failed cleanup
    try {
      await prisma.dataRetentionLog.create({
        data: {
          recordsDeleted: 0,
          retentionDays: retentionMonths * 30,
          success: false,
          error: errorMessage
        }
      })
    } catch (logError) {
      console.error('[Cleanup] Error logging cleanup failure:', logError)
    }

    return {
      success: false,
      sensorDataDeleted: 0,
      eventsDeleted: 0,
      retentionMonths,
      error: errorMessage
    }
  }
}

/**
 * Get the latest cleanup logs
 */
export async function getCleanupLogs(limit: number = 10) {
  return prisma.dataRetentionLog.findMany({
    orderBy: { runAt: 'desc' },
    take: limit
  })
}
