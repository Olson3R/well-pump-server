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

// ---------------------------------------------------------------------------
// Query tuning constants
// ---------------------------------------------------------------------------

/**
 * Default page size used ONLY for unbounded listings (no startDate/endDate).
 * Bounded (date-range) queries are never silently capped — see GET below.
 */
const DEFAULT_UNBOUNDED_LIMIT = 100

/**
 * Maximum number of raw rows a single bounded query may return before the
 * server transparently downsamples (aggregates) instead. This guarantees the
 * full selected range is always represented while keeping payloads bounded.
 * Data arrives ~1 row/minute, so 5000 rows ≈ 3.5 days of un-aggregated data.
 */
const MAX_RAW_ROWS = 5000

/**
 * Upper bound on the number of aggregated buckets we aim to return. Used when
 * auto-selecting a downsampling interval so long ranges stay responsive while
 * still covering the entire window.
 */
const MAX_AGG_BUCKETS = 750

const VALID_AGGREGATES = ['hour', '6hour', 'day'] as const
type AggregateInterval = (typeof VALID_AGGREGATES)[number]

/** SQL expression that truncates `timestamp` to the start of its bucket. */
function bucketExpression(interval: AggregateInterval): Prisma.Sql {
  switch (interval) {
    case 'day':
      return Prisma.sql`date_trunc('day', timestamp)`
    case '6hour':
      return Prisma.sql`date_trunc('hour', timestamp) - (EXTRACT(hour FROM timestamp)::int % 6) * interval '1 hour'`
    case 'hour':
    default:
      return Prisma.sql`date_trunc('hour', timestamp)`
  }
}

/**
 * Pick the smallest bucket size that keeps the number of buckets spanning
 * [start, end] at or below MAX_AGG_BUCKETS, so the whole window is covered
 * without returning an unbounded number of points.
 */
function pickAggregateInterval(start: Date, end: Date): AggregateInterval {
  const HOUR_MS = 60 * 60 * 1000
  const spanMs = Math.max(0, end.getTime() - start.getTime())

  if (spanMs / HOUR_MS <= MAX_AGG_BUCKETS) return 'hour'
  if (spanMs / (6 * HOUR_MS) <= MAX_AGG_BUCKETS) return '6hour'
  return 'day'
}

/**
 * Run a downsampling aggregation query over the selected window. Returns one
 * averaged row per time bucket, oldest-to-newest is handled by the client;
 * here we return newest-first for parity with the raw query.
 */
async function aggregateWindow(
  interval: AggregateInterval,
  start: Date,
  end: Date,
  device: string | null
) {
  const bucket = bucketExpression(interval)
  const deviceCondition = device ? Prisma.sql`AND device = ${device}` : Prisma.empty

  return prisma.$queryRaw`
    SELECT
      ${bucket} as timestamp,
      MIN(${bucket})::text as id,
      AVG("tempAvg") as "tempAvg",
      AVG("humAvg") as "humAvg",
      AVG("pressAvg") as "pressAvg",
      MIN("pressMin") as "pressMin",
      MAX("pressMax") as "pressMax",
      AVG("current1Avg") as "current1Avg",
      AVG("current2Avg") as "current2Avg",
      AVG("current1RMS") as "current1RMS",
      AVG("current2RMS") as "current2RMS",
      AVG("dutyCycle1") as "dutyCycle1",
      AVG("dutyCycle2") as "dutyCycle2",
      COUNT(*)::int as "sampleCount"
    FROM sensor_data
    WHERE timestamp >= ${start}
      AND timestamp <= ${end}
      ${deviceCondition}
    GROUP BY ${bucket}
    ORDER BY timestamp DESC
  ` as Promise<Array<Record<string, unknown>>>
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
    const offsetParam = searchParams.get('offset')
    const device = searchParams.get('device')
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')
    const aggregateParam = searchParams.get('aggregate')

    // --- Validate pagination params ------------------------------------------
    const hasExplicitLimit = limitParam !== null
    let limit: number | null = null
    if (hasExplicitLimit) {
      limit = parseInt(limitParam as string, 10)
      if (Number.isNaN(limit) || limit < 0) {
        return NextResponse.json(
          { error: 'Invalid limit: must be a non-negative integer' },
          { status: 400 }
        )
      }
    }

    let offset = 0
    if (offsetParam !== null) {
      offset = parseInt(offsetParam, 10)
      if (Number.isNaN(offset) || offset < 0) {
        return NextResponse.json(
          { error: 'Invalid offset: must be a non-negative integer' },
          { status: 400 }
        )
      }
    }

    // --- Validate / parse range params ---------------------------------------
    if (aggregateParam !== null && !VALID_AGGREGATES.includes(aggregateParam as AggregateInterval)) {
      return NextResponse.json(
        { error: `Invalid aggregate: must be one of ${VALID_AGGREGATES.join(', ')}` },
        { status: 400 }
      )
    }
    const explicitAggregate = aggregateParam as AggregateInterval | null

    const start = startDate ? new Date(startDate) : null
    const end = endDate ? new Date(endDate) : null
    if (start && Number.isNaN(start.getTime())) {
      return NextResponse.json({ error: 'Invalid startDate' }, { status: 400 })
    }
    if (end && Number.isNaN(end.getTime())) {
      return NextResponse.json({ error: 'Invalid endDate' }, { status: 400 })
    }

    const bounded = Boolean(start || end)
    const canAggregate = Boolean(start && end)

    const where: {
      device?: string
      timestamp?: { gte?: Date; lte?: Date }
    } = {}
    if (device) where.device = device
    if (start || end) {
      where.timestamp = {}
      if (start) where.timestamp.gte = start
      if (end) where.timestamp.lte = end
    }

    // Total number of raw rows matching the filter (drives paging + downsample).
    const total = await prisma.sensorData.count({ where })

    // --- Decide whether to downsample ----------------------------------------
    // Aggregate when the client explicitly asks, OR when an un-paginated bounded
    // window would exceed the raw-row budget. Either way the ENTIRE window is
    // represented — nothing is silently dropped.
    let interval: AggregateInterval | null = null
    let autoAggregated = false
    if (explicitAggregate && canAggregate) {
      interval = explicitAggregate
    } else if (canAggregate && !hasExplicitLimit && total > MAX_RAW_ROWS) {
      interval = pickAggregateInterval(start as Date, end as Date)
      autoAggregated = true
    }

    if (interval) {
      const aggregatedData = await aggregateWindow(interval, start as Date, end as Date, device)
      return NextResponse.json(
        {
          data: aggregatedData,
          aggregation: {
            interval,
            auto: autoAggregated,
            startDate: (start as Date).toISOString(),
            endDate: (end as Date).toISOString(),
          },
          pagination: {
            // Aggregated responses always return every bucket for the window.
            total: aggregatedData.length,
            returned: aggregatedData.length,
            offset: 0,
            hasMore: false,
          },
        },
        { headers: { 'Cache-Control': 'no-store' } }
      )
    }

    // --- Raw rows ------------------------------------------------------------
    // take resolution:
    //   - explicit limit  -> honor it (cursor/offset paging path)
    //   - bounded, no limit -> return the WHOLE window (capped only by the raw
    //     budget, and only when we could not aggregate, e.g. one-sided range)
    //   - unbounded, no limit -> default page size
    let take: number | undefined
    if (hasExplicitLimit) {
      take = limit as number
    } else if (bounded) {
      take = canAggregate ? undefined : Math.min(total, MAX_RAW_ROWS) || undefined
    } else {
      take = DEFAULT_UNBOUNDED_LIMIT
    }

    const sensorData = await prisma.sensorData.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      ...(take !== undefined ? { take } : {}),
      skip: offset,
    })

    return NextResponse.json(
      {
        data: sensorData,
        pagination: {
          total,
          ...(take !== undefined ? { limit: take } : {}),
          offset,
          returned: sensorData.length,
          // hasMore is derived from what was actually returned, never hardcoded.
          hasMore: offset + sensorData.length < total,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (error) {
    console.error('Error fetching sensor data:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}