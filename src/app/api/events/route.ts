import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { EventType } from '@prisma/client'
import { getAuthContext, hasPermission } from '@/lib/auth-middleware'

export async function POST(request: NextRequest) {
  try {
    // Check authentication for POST requests (device token required)
    const authContext = await getAuthContext(request)
    if (!hasPermission(authContext, 'events')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

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

    const timestamp = new Date(parseInt(data.timestamp))
    const startTime = new Date(parseInt(data.startTime))
    const duration = BigInt(data.duration)
    const isActive = data.active

    // Find existing active event of the same type for this device
    const existingEvent = await prisma.event.findFirst({
      where: {
        device: data.device,
        type: eventType,
        active: true
      },
      orderBy: { timestamp: 'desc' }
    })

    if (isActive) {
      // Condition is active
      if (existingEvent) {
        // Update existing active event with new values
        const result = await prisma.event.update({
          where: { id: existingEvent.id },
          data: {
            timestamp,
            value: data.value,
            duration,
            description: data.description
          }
        })

        return NextResponse.json(
          {
            success: true,
            id: result.id,
            message: 'Existing event updated',
            updated: true
          },
          { status: 200 }
        )
      } else {
        // Create new active event
        const result = await prisma.event.create({
          data: {
            device: data.device,
            location: data.location,
            timestamp,
            type: eventType,
            value: data.value,
            threshold: data.threshold,
            startTime,
            duration,
            active: true,
            description: data.description
          }
        })

        return NextResponse.json(
          {
            success: true,
            id: result.id,
            message: 'Event created',
            created: true
          },
          { status: 201 }
        )
      }
    } else {
      // Condition has cleared - resolve any active event
      if (existingEvent) {
        const result = await prisma.event.update({
          where: { id: existingEvent.id },
          data: {
            active: false,
            timestamp, // Update to resolution time
            duration
          }
        })

        return NextResponse.json(
          {
            success: true,
            id: result.id,
            message: 'Event resolved',
            resolved: true
          },
          { status: 200 }
        )
      } else {
        // No active event to resolve - nothing to do
        return NextResponse.json(
          {
            success: true,
            message: 'No active event to resolve'
          },
          { status: 200 }
        )
      }
    }

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
    // Check authentication for GET requests (session or device token)
    const authContext = await getAuthContext(request)
    if (!hasPermission(authContext, 'events')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
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

    if (action === 'resolve') {
      await prisma.event.update({
        where: { id: eventId },
        data: {
          active: false
        }
      })

      return NextResponse.json({
        success: true,
        message: 'Event resolved successfully'
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