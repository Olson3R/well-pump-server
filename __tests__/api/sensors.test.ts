/**
 * @jest-environment node
 *
 * API route tests run in the Node environment so the Web `Request`/`Response`
 * globals used by `next/server` are available (they are absent under jsdom).
 */
import { NextRequest } from 'next/server'
import { POST, GET } from '@/app/api/sensors/route'
import { prisma } from '@/lib/prisma'

// Mock Prisma (raw query + model delegates)
jest.mock('@/lib/prisma', () => ({
  prisma: {
    sensorData: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    $queryRaw: jest.fn(),
  },
}))

// Grant access in every test; auth itself is covered elsewhere.
jest.mock('@/lib/auth-middleware', () => ({
  getAuthContext: jest.fn().mockResolvedValue({
    isAuthenticated: true,
    user: { id: '1', username: 'tester', role: 'ADMIN' },
    authMethod: 'session',
  }),
  hasPermission: jest.fn().mockReturnValue(true),
}))

const mockPrisma = prisma as unknown as {
  sensorData: {
    create: jest.Mock
    findMany: jest.Mock
    count: jest.Mock
  }
  $queryRaw: jest.Mock
}

// Backend tuning constants mirrored from the route (keep in sync).
const DEFAULT_UNBOUNDED_LIMIT = 100
const MAX_RAW_ROWS = 5000

const url = (qs = '') => `http://localhost:3000/api/sensors${qs}`

describe('/api/sensors', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('POST', () => {
    const validSensorData = {
      device: 'well-pump-monitor',
      location: 'Pump House',
      timestamp: '1640995200000',
      startTime: '1640995140000',
      endTime: '1640995200000',
      sampleCount: 60,
      tempMin: 18.5,
      tempMax: 19.2,
      tempAvg: 18.8,
      humMin: 65.0,
      humMax: 68.5,
      humAvg: 66.7,
      pressMin: 38.2,
      pressMax: 42.1,
      pressAvg: 40.3,
      current1Min: 0.1,
      current1Max: 7.8,
      current1Avg: 2.3,
      current1RMS: 2.8,
      dutyCycle1: 0.35,
      current2Min: 0.0,
      current2Max: 0.2,
      current2Avg: 0.1,
      current2RMS: 0.1,
      dutyCycle2: 0.0,
    }

    it('should create sensor data successfully', async () => {
      mockPrisma.sensorData.create.mockResolvedValue({
        id: 'test-id',
        ...validSensorData,
        timestamp: new Date(parseInt(validSensorData.timestamp)),
        startTime: new Date(parseInt(validSensorData.startTime)),
        endTime: new Date(parseInt(validSensorData.endTime)),
        createdAt: new Date(),
      })

      const request = new NextRequest(url(), {
        method: 'POST',
        body: JSON.stringify(validSensorData),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.success).toBe(true)
      expect(data.id).toBe('test-id')
      expect(mockPrisma.sensorData.create).toHaveBeenCalledWith({
        data: {
          ...validSensorData,
          timestamp: new Date(parseInt(validSensorData.timestamp)),
          startTime: new Date(parseInt(validSensorData.startTime)),
          endTime: new Date(parseInt(validSensorData.endTime)),
        },
      })
    })

    it('should return 400 for missing required fields', async () => {
      const request = new NextRequest(url(), {
        method: 'POST',
        body: JSON.stringify({ device: 'well-pump-monitor' }),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toContain('Missing required field')
    })

    it('should handle database errors', async () => {
      mockPrisma.sensorData.create.mockRejectedValue(new Error('Database error'))

      const request = new NextRequest(url(), {
        method: 'POST',
        body: JSON.stringify(validSensorData),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(500)
      expect(data.error).toBe('Internal server error')
    })
  })

  describe('GET — unbounded listings', () => {
    it('applies the default page size and computes hasMore when more rows exist', async () => {
      mockPrisma.sensorData.findMany.mockResolvedValue(
        Array.from({ length: DEFAULT_UNBOUNDED_LIMIT }, (_, i) => ({ id: String(i) }))
      )
      mockPrisma.sensorData.count.mockResolvedValue(250)

      const response = await GET(new NextRequest(url()))
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(mockPrisma.sensorData.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { timestamp: 'desc' },
        take: DEFAULT_UNBOUNDED_LIMIT,
        skip: 0,
      })
      expect(data.pagination).toMatchObject({
        total: 250,
        limit: DEFAULT_UNBOUNDED_LIMIT,
        offset: 0,
        returned: DEFAULT_UNBOUNDED_LIMIT,
        hasMore: true,
      })
    })

    it('reports hasMore=false once the final page is reached', async () => {
      mockPrisma.sensorData.findMany.mockResolvedValue(
        Array.from({ length: 50 }, (_, i) => ({ id: String(i) }))
      )
      mockPrisma.sensorData.count.mockResolvedValue(250)

      const response = await GET(new NextRequest(url('?limit=100&offset=200')))
      const data = await response.json()

      expect(mockPrisma.sensorData.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { timestamp: 'desc' },
        take: 100,
        skip: 200,
      })
      // 200 + 50 === 250 => no more pages.
      expect(data.pagination.hasMore).toBe(false)
      expect(data.pagination.offset).toBe(200)
    })

    it('filters by device', async () => {
      mockPrisma.sensorData.findMany.mockResolvedValue([])
      mockPrisma.sensorData.count.mockResolvedValue(0)

      await GET(new NextRequest(url('?device=test-device')))

      expect(mockPrisma.sensorData.findMany).toHaveBeenCalledWith({
        where: { device: 'test-device' },
        orderBy: { timestamp: 'desc' },
        take: DEFAULT_UNBOUNDED_LIMIT,
        skip: 0,
      })
    })
  })

  describe('GET — bounded (date range) queries return the full window', () => {
    it('returns EVERY row in a short window with no take cap (no silent truncation)', async () => {
      const startDate = '2023-01-01T00:00:00.000Z'
      const endDate = '2023-01-01T06:00:00.000Z'
      // ~360 one-minute rows: comfortably under the raw-row budget.
      const rows = Array.from({ length: 360 }, (_, i) => ({ id: String(i) }))
      mockPrisma.sensorData.findMany.mockResolvedValue(rows)
      mockPrisma.sensorData.count.mockResolvedValue(360)

      const response = await GET(
        new NextRequest(url(`?startDate=${startDate}&endDate=${endDate}`))
      )
      const data = await response.json()

      const call = mockPrisma.sensorData.findMany.mock.calls[0][0]
      expect(call.where).toEqual({
        timestamp: { gte: new Date(startDate), lte: new Date(endDate) },
      })
      // Crucially: no `take` => the entire window is returned.
      expect(call).not.toHaveProperty('take')
      expect(call.skip).toBe(0)

      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled()
      expect(data.data).toHaveLength(360)
      expect(data.pagination).toMatchObject({ total: 360, returned: 360, hasMore: false })
    })

    it('auto-downsamples a long window instead of dropping data', async () => {
      const startDate = '2023-01-01T00:00:00.000Z'
      const endDate = '2023-01-11T00:00:00.000Z' // 10 days => > MAX_RAW_ROWS rows
      const buckets = Array.from({ length: 240 }, (_, i) => ({
        timestamp: new Date(),
        id: String(i),
        tempAvg: 20,
      }))
      mockPrisma.$queryRaw.mockResolvedValue(buckets)
      mockPrisma.sensorData.count.mockResolvedValue(MAX_RAW_ROWS * 2)

      const response = await GET(
        new NextRequest(url(`?startDate=${startDate}&endDate=${endDate}`))
      )
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1)
      expect(mockPrisma.sensorData.findMany).not.toHaveBeenCalled()
      expect(data.aggregation).toMatchObject({ interval: 'hour', auto: true })
      expect(data.aggregation.startDate).toBe(new Date(startDate).toISOString())
      expect(data.aggregation.endDate).toBe(new Date(endDate).toISOString())
      expect(data.data).toHaveLength(240)
      expect(data.pagination).toMatchObject({ total: 240, hasMore: false })
    })

    it('honors an explicit aggregate=hour request', async () => {
      const startDate = '2023-01-01T00:00:00.000Z'
      const endDate = '2023-01-08T00:00:00.000Z'
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'b1', timestamp: new Date() }])
      mockPrisma.sensorData.count.mockResolvedValue(100) // small, but aggregate is explicit

      const response = await GET(
        new NextRequest(url(`?startDate=${startDate}&endDate=${endDate}&aggregate=hour`))
      )
      const data = await response.json()

      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1)
      expect(data.aggregation).toMatchObject({ interval: 'hour', auto: false })
    })

    it('honors an explicit aggregate=6hour request', async () => {
      const startDate = '2023-01-01T00:00:00.000Z'
      const endDate = '2023-01-31T00:00:00.000Z'
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'b1', timestamp: new Date() }])
      mockPrisma.sensorData.count.mockResolvedValue(100)

      const response = await GET(
        new NextRequest(url(`?startDate=${startDate}&endDate=${endDate}&aggregate=6hour`))
      )
      const data = await response.json()

      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1)
      expect(data.aggregation).toMatchObject({ interval: '6hour', auto: false })
    })

    it('lets an explicit limit page through a bounded range (raw, not aggregated)', async () => {
      const startDate = '2023-01-01T00:00:00.000Z'
      const endDate = '2023-02-01T00:00:00.000Z' // long range...
      mockPrisma.sensorData.findMany.mockResolvedValue(
        Array.from({ length: 500 }, (_, i) => ({ id: String(i) }))
      )
      mockPrisma.sensorData.count.mockResolvedValue(MAX_RAW_ROWS * 2)

      const response = await GET(
        new NextRequest(url(`?startDate=${startDate}&endDate=${endDate}&limit=500&offset=1000`))
      )
      const data = await response.json()

      // ...but an explicit limit means the client opted into paging, so no aggregation.
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled()
      expect(mockPrisma.sensorData.findMany).toHaveBeenCalledWith({
        where: { timestamp: { gte: new Date(startDate), lte: new Date(endDate) } },
        orderBy: { timestamp: 'desc' },
        take: 500,
        skip: 1000,
      })
      expect(data.pagination).toMatchObject({ limit: 500, offset: 1000, hasMore: true })
    })

    it('caps a one-sided huge range to the raw budget and signals hasMore', async () => {
      // Only startDate => cannot compute a bucketed window => fall back to a
      // capped raw page, but hasMore=true so nothing is *silently* dropped.
      const startDate = '2023-01-01T00:00:00.000Z'
      mockPrisma.sensorData.findMany.mockResolvedValue(
        Array.from({ length: MAX_RAW_ROWS }, (_, i) => ({ id: String(i) }))
      )
      mockPrisma.sensorData.count.mockResolvedValue(MAX_RAW_ROWS * 3)

      const response = await GET(new NextRequest(url(`?startDate=${startDate}`)))
      const data = await response.json()

      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled()
      const call = mockPrisma.sensorData.findMany.mock.calls[0][0]
      expect(call.take).toBe(MAX_RAW_ROWS)
      expect(data.pagination.hasMore).toBe(true)
    })
  })

  describe('GET — validation & errors', () => {
    it('rejects an invalid aggregate value', async () => {
      const response = await GET(
        new NextRequest(url('?startDate=2023-01-01&endDate=2023-01-02&aggregate=year'))
      )
      const data = await response.json()
      expect(response.status).toBe(400)
      expect(data.error).toContain('Invalid aggregate')
    })

    it('rejects a negative limit', async () => {
      const response = await GET(new NextRequest(url('?limit=-5')))
      expect(response.status).toBe(400)
    })

    it('rejects a non-numeric offset', async () => {
      const response = await GET(new NextRequest(url('?offset=abc')))
      expect(response.status).toBe(400)
    })

    it('rejects an invalid startDate', async () => {
      const response = await GET(new NextRequest(url('?startDate=not-a-date')))
      const data = await response.json()
      expect(response.status).toBe(400)
      expect(data.error).toContain('Invalid startDate')
    })

    it('returns 500 on database errors', async () => {
      mockPrisma.sensorData.count.mockRejectedValue(new Error('Database error'))

      const response = await GET(new NextRequest(url()))
      const data = await response.json()

      expect(response.status).toBe(500)
      expect(data.error).toBe('Internal server error')
    })
  })
})
