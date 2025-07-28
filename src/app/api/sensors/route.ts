import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
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
    const limit = parseInt(searchParams.get('limit') || '100')
    const offset = parseInt(searchParams.get('offset') || '0')
    const device = searchParams.get('device')
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')

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
      take: limit,
      skip: offset
    })

    const total = await prisma.sensorData.count({ where })

    return NextResponse.json({
      data: sensorData,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total
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