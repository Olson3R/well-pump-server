import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import { getAuthContext, hasPermission } from '@/lib/auth-middleware'

export async function POST(request: NextRequest) {
  try {
    // Check authentication for POST requests (device token required)
    const authContext = await getAuthContext(request)
    if (!hasPermission(authContext, 'sensors')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const data = await request.json()
    
    // Validate required fields based on ESP32 data structure
    const requiredFields = [
      'device', 'location', 'timestamp', 'startTime', 'endTime', 'sampleCount',
      'tempMin', 'tempMax', 'tempAvg',
      'humMin', 'humMax', 'humAvg', 
      'pressMin', 'pressMax', 'pressAvg',
      'current1Min', 'current1Max', 'current1Avg', 'current1RMS', 'dutyCycle1',
      'current2Min', 'current2Max', 'current2Avg', 'current2RMS', 'dutyCycle2'
    ]

    for (const field of requiredFields) {
      if (!(field in data)) {
        return NextResponse.json(
          { error: `Missing required field: ${field}` },
          { status: 400 }
        )
      }
    }

    // Convert timestamp strings to Date objects
    const sensorData = {
      ...data,
      timestamp: new Date(parseInt(data.timestamp)),
      startTime: new Date(parseInt(data.startTime)),
      endTime: new Date(parseInt(data.endTime))
    }

    // Save to database
    const result = await prisma.sensorData.create({
      data: sensorData
    })

    return NextResponse.json(
      { 
        success: true, 
        id: result.id,
        message: 'Sensor data saved successfully' 
      },
      { status: 201 }
    )

  } catch (error) {
    console.error('Error saving sensor data:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest) {
  try {
    // Check authentication for GET requests (session or device token)
    const authContext = await getAuthContext(request)
    if (!hasPermission(authContext, 'sensors')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const { searchParams } = new URL(request.url)
    const limitParam = searchParams.get('limit')
    const limit = limitParam ? parseInt(limitParam) : null
    const offset = parseInt(searchParams.get('offset') || '0')
    const device = searchParams.get('device')
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')
    const aggregate = searchParams.get('aggregate') // 'hour' or '6hour'

    // Handle aggregated queries for longer time ranges
    if (aggregate && startDate && endDate) {
      const deviceCondition = device
        ? Prisma.sql`AND device = ${device}`
        : Prisma.empty

      let aggregatedData
      if (aggregate === '6hour') {
        aggregatedData = await prisma.$queryRaw`
          SELECT
            date_trunc('hour', timestamp) - (EXTRACT(hour FROM timestamp)::int % 6) * interval '1 hour' as timestamp,
            AVG("tempAvg") as "tempAvg",
            AVG("humAvg") as "humAvg",
            AVG("pressAvg") as "pressAvg",
            AVG("current1Avg") as "current1Avg",
            AVG("current2Avg") as "current2Avg",
            AVG("current1RMS") as "current1RMS",
            AVG("current2RMS") as "current2RMS",
            AVG("dutyCycle1") as "dutyCycle1",
            AVG("dutyCycle2") as "dutyCycle2",
            COUNT(*)::int as "sampleCount"
          FROM sensor_data
          WHERE timestamp >= ${new Date(startDate)}
            AND timestamp <= ${new Date(endDate)}
            ${deviceCondition}
          GROUP BY date_trunc('hour', timestamp) - (EXTRACT(hour FROM timestamp)::int % 6) * interval '1 hour'
          ORDER BY timestamp DESC
        `
      } else {
        aggregatedData = await prisma.$queryRaw`
          SELECT
            date_trunc('hour', timestamp) as timestamp,
            AVG("tempAvg") as "tempAvg",
            AVG("humAvg") as "humAvg",
            AVG("pressAvg") as "pressAvg",
            AVG("current1Avg") as "current1Avg",
            AVG("current2Avg") as "current2Avg",
            AVG("current1RMS") as "current1RMS",
            AVG("current2RMS") as "current2RMS",
            AVG("dutyCycle1") as "dutyCycle1",
            AVG("dutyCycle2") as "dutyCycle2",
            COUNT(*)::int as "sampleCount"
          FROM sensor_data
          WHERE timestamp >= ${new Date(startDate)}
            AND timestamp <= ${new Date(endDate)}
            ${deviceCondition}
          GROUP BY date_trunc('hour', timestamp)
          ORDER BY timestamp DESC
        `
      }

      return NextResponse.json({
        data: aggregatedData,
        aggregation: {
          interval: aggregate,
          startDate,
          endDate
        }
      })
    }

    const where: {
      device?: string;
      timestamp?: {
        gte?: Date;
        lte?: Date;
      };
    } = {}

    if (device) {
      where.device = device
    }

    if (startDate || endDate) {
      where.timestamp = {}
      if (startDate) {
        where.timestamp.gte = new Date(startDate)
      }
      if (endDate) {
        where.timestamp.lte = new Date(endDate)
      }
    }

    const sensorData = await prisma.sensorData.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      ...(limit ? { take: limit } : {}),
      skip: offset
    })

    const total = await prisma.sensorData.count({ where })

    return NextResponse.json({
      data: sensorData,
      pagination: {
        total,
        ...(limit ? { limit } : {}),
        offset,
        hasMore: limit ? offset + limit < total : false
      }
    })

  } catch (error) {
    console.error('Error fetching sensor data:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}