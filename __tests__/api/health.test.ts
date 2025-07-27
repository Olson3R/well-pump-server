import { NextRequest } from 'next/server'
import { GET } from '@/app/api/health/route'
import { prisma } from '@/lib/prisma'

// Mock Prisma
jest.mock('@/lib/prisma', () => ({
  prisma: {
    $queryRaw: jest.fn(),
    sensorData: {
      findFirst: jest.fn(),
    },
    event: {
      count: jest.fn(),
    },
    user: {
      count: jest.fn(),
    },
  },
}))

const mockPrisma = prisma as jest.Mocked<typeof prisma>

describe('/api/health', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2023-01-01T12:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('should return healthy status with recent data', async () => {
    const recentTimestamp = new Date('2023-01-01T11:58:00.000Z') // 2 minutes ago
    
    mockPrisma.$queryRaw.mockResolvedValue([{ test: 1 }])
    mockPrisma.sensorData.findFirst.mockResolvedValue({
      id: '1',
      timestamp: recentTimestamp,
    } as any)
    mockPrisma.event.count.mockResolvedValue(0)
    mockPrisma.user.count.mockResolvedValue(1)

    const request = new NextRequest('http://localhost:3000/api/health')
    const response = await GET(request)
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.status).toBe('healthy')
    expect(data.database).toBe('connected')
    expect(data.dataIngestion).toBe('active')
    expect(data.activeAlerts).toBe(0)
    expect(data.lastDataReceived).toBe(recentTimestamp.toISOString())
  })

  it('should return degraded status with stale data', async () => {
    const staleTimestamp = new Date('2023-01-01T10:00:00.000Z') // 2 hours ago
    
    mockPrisma.$queryRaw.mockResolvedValue([{ test: 1 }])
    mockPrisma.sensorData.findFirst.mockResolvedValue({
      id: '1',
      timestamp: staleTimestamp,
    } as any)
    mockPrisma.event.count.mockResolvedValue(0)
    mockPrisma.user.count.mockResolvedValue(1)

    const request = new NextRequest('http://localhost:3000/api/health')
    const response = await GET(request)
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.status).toBe('degraded')
    expect(data.dataIngestion).toBe('stale')
  })

  it('should return warning status with few active alerts', async () => {
    const recentTimestamp = new Date('2023-01-01T11:58:00.000Z')
    
    mockPrisma.$queryRaw.mockResolvedValue([{ test: 1 }])
    mockPrisma.sensorData.findFirst.mockResolvedValue({
      id: '1',
      timestamp: recentTimestamp,
    } as any)
    mockPrisma.event.count.mockResolvedValue(3) // 3 active alerts
    mockPrisma.user.count.mockResolvedValue(1)

    const request = new NextRequest('http://localhost:3000/api/health')
    const response = await GET(request)
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.status).toBe('warning')
    expect(data.activeAlerts).toBe(3)
  })

  it('should return unhealthy status with many active alerts', async () => {
    const recentTimestamp = new Date('2023-01-01T11:58:00.000Z')
    
    mockPrisma.$queryRaw.mockResolvedValue([{ test: 1 }])
    mockPrisma.sensorData.findFirst.mockResolvedValue({
      id: '1',
      timestamp: recentTimestamp,
    } as any)
    mockPrisma.event.count.mockResolvedValue(10) // 10 active alerts
    mockPrisma.user.count.mockResolvedValue(1)

    const request = new NextRequest('http://localhost:3000/api/health')
    const response = await GET(request)
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.status).toBe('unhealthy')
    expect(data.activeAlerts).toBe(10)
  })

  it('should handle database connection errors', async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error('Connection failed'))

    const request = new NextRequest('http://localhost:3000/api/health')
    const response = await GET(request)
    const data = await response.json()

    expect(response.status).toBe(503)
    expect(data.status).toBe('unhealthy')
    expect(data.database).toBe('disconnected')
    expect(data.error).toBe('Connection failed')
  })

  it('should handle missing sensor data', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ test: 1 }])
    mockPrisma.sensorData.findFirst.mockResolvedValue(null)
    mockPrisma.event.count.mockResolvedValue(0)
    mockPrisma.user.count.mockResolvedValue(1)

    const request = new NextRequest('http://localhost:3000/api/health')
    const response = await GET(request)
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.status).toBe('degraded')
    expect(data.dataIngestion).toBe('stale')
    expect(data.lastDataReceived).toBeNull()
  })

  it('should include system statistics', async () => {
    const recentTimestamp = new Date('2023-01-01T11:58:00.000Z')
    
    mockPrisma.$queryRaw.mockResolvedValue([{ test: 1 }])
    mockPrisma.sensorData.findFirst.mockResolvedValue({
      id: '1',
      timestamp: recentTimestamp,
    } as any)
    mockPrisma.event.count
      .mockResolvedValueOnce(2) // Active events count
      .mockResolvedValueOnce(150) // Total events count
    mockPrisma.user.count.mockResolvedValue(3)

    const request = new NextRequest('http://localhost:3000/api/health')
    const response = await GET(request)
    const data = await response.json()

    expect(data.stats).toEqual({
      sensorRecords: expect.any(Number),
      events: 150,
      users: 3,
    })
  })
})