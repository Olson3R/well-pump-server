import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  try {
    // Check database connectivity
    await prisma.$queryRaw`SELECT 1`
    
    // Get latest sensor data to check if ESP32 is sending data
    const latestData = await prisma.sensorData.findFirst({
      orderBy: { timestamp: 'desc' }
    })
    
    const now = new Date()
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000)
    
    const isReceivingData = latestData && new Date(latestData.timestamp) > fiveMinutesAgo
    
    // Get active events count
    const activeEvents = await prisma.event.count({
      where: { active: true }
    })
    
    // Get system stats
    const [totalSensorRecords, totalEvents, totalUsers] = await Promise.all([
      prisma.sensorData.count(),
      prisma.event.count(),
      prisma.user.count()
    ])

    const health = {
      status: 'healthy',
      timestamp: now.toISOString(),
      database: 'connected',
      dataIngestion: isReceivingData ? 'active' : 'stale',
      lastDataReceived: latestData?.timestamp || null,
      activeAlerts: activeEvents,
      stats: {
        sensorRecords: totalSensorRecords,
        events: totalEvents,
        users: totalUsers
      }
    }

    // Determine overall health status
    if (!isReceivingData) {
      health.status = 'degraded'
    }
    
    if (activeEvents > 0) {
      health.status = activeEvents > 5 ? 'unhealthy' : 'warning'
    }

    return NextResponse.json(health)
    
  } catch (error) {
    console.error('Health check failed:', error)
    
    return NextResponse.json(
      {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        database: 'disconnected',
        error: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 503 }
    )
  }
}