import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { EventType } from '@prisma/client'

export async function POST(request: NextRequest) {
  try {
    const data = await request.json()
    
    // Validate required fields based on ESP32 event structure
    const requiredFields = [
      'device', 'location', 'timestamp', 'type', 'value', 'threshold',
      'startTime', 'duration', 'active', 'description'
    ]

    for (const field of requiredFields) {
      if (!(field in data)) {
        return NextResponse.json(
          { error: `Missing required field: ${field}` },
          { status: 400 }
        )
      }
    }

    // Map ESP32 event types to our enum
    const eventTypeMap: { [key: number]: EventType } = {
      1: EventType.HIGH_CURRENT,
      2: EventType.LOW_PRESSURE,
      3: EventType.LOW_TEMPERATURE,
      4: EventType.SENSOR_ERROR,
      5: EventType.SYSTEM_ERROR
    }

    const eventType = eventTypeMap[data.type]
    if (!eventType) {
      return NextResponse.json(
        { error: `Invalid event type: ${data.type}` },
        { status: 400 }
      )
    }

    // Convert timestamp strings to Date objects
    const eventData = {
      ...data,
      type: eventType,
      timestamp: new Date(parseInt(data.timestamp)),
      startTime: new Date(parseInt(data.startTime)),
      duration: BigInt(data.duration)
    }

    // Save to database
    const result = await prisma.event.create({
      data: eventData
    })

    return NextResponse.json(
      { 
        success: true, 
        id: result.id,
        message: 'Event saved successfully' 
      },
      { status: 201 }
    )

  } catch (error) {
    console.error('Error saving event:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get('limit') || '100')
    const offset = parseInt(searchParams.get('offset') || '0')
    const device = searchParams.get('device')
    const active = searchParams.get('active')
    const eventType = searchParams.get('type')
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')

    const where: {
      device?: string
      active?: boolean
      type?: EventType
      timestamp?: {
        gte?: Date
        lte?: Date
      }
    } = {}
    
    if (device) {
      where.device = device
    }
    
    if (active !== null) {
      where.active = active === 'true'
    }
    
    if (eventType) {
      where.type = eventType as EventType
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

    const events = await prisma.event.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: limit,
      skip: offset
    })

    const total = await prisma.event.count({ where })

    // Convert BigInt duration to string for JSON serialization
    const serializedEvents = events.map(event => ({
      ...event,
      duration: event.duration.toString()
    }))

    return NextResponse.json({
      data: serializedEvents,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total
      }
    })

  } catch (error) {
    console.error('Error fetching events:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const eventId = searchParams.get('id')
    const action = searchParams.get('action')

    if (!eventId) {
      return NextResponse.json(
        { error: 'Event ID is required' },
        { status: 400 }
      )
    }

    if (action === 'acknowledge') {
      await prisma.event.update({
        where: { id: eventId },
        data: {
          acknowledged: true,
          acknowledgedAt: new Date()
        }
      })

      return NextResponse.json({
        success: true,
        message: 'Event acknowledged successfully'
      })
    }

    return NextResponse.json(
      { error: 'Invalid action' },
      { status: 400 }
    )

  } catch (error) {
    console.error('Error updating event:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}