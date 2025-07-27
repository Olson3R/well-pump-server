import { NextRequest } from 'next/server'
import { POST as sensorPost } from '@/app/api/sensors/route'
import { POST as eventPost } from '@/app/api/events/route'
import { GET as healthGet } from '@/app/api/health/route'
import { prisma } from '@/lib/prisma'

// Mock Prisma
jest.mock('@/lib/prisma', () => ({
  prisma: {
    sensorData: {
      create: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
    },
    event: {
      create: jest.fn(),
      count: jest.fn(),
    },
    user: {
      count: jest.fn(),
    },
    $queryRaw: jest.fn(),
  },
}))

const mockPrisma = prisma as jest.Mocked<typeof prisma>

describe('Data Flow Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2023-01-01T12:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('should handle complete ESP32 data submission flow', async () => {
    // Mock database responses
    const mockSensorRecord = {
      id: 'sensor-1',
      device: 'well-pump-monitor',
      timestamp: new Date('2023-01-01T12:00:00.000Z'),
    }

    const mockEventRecord = {
      id: 'event-1',
      device: 'well-pump-monitor',
      type: 'HIGH_CURRENT',
      active: true,
    }

    mockPrisma.sensorData.create.mockResolvedValue(mockSensorRecord as any)
    mockPrisma.event.create.mockResolvedValue(mockEventRecord as any)

    // 1. Submit sensor data
    const sensorData = {
      device: 'well-pump-monitor',
      location: 'Pump House',
      timestamp: '1672574400000', // 2023-01-01T12:00:00.000Z
      startTime: '1672574340000',
      endTime: '1672574400000',
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
      current1Max: 8.5, // High current!
      current1Avg: 4.3,
      current1RMS: 5.2,
      dutyCycle1: 0.75,
      current2Min: 0.0,
      current2Max: 0.2,
      current2Avg: 0.1,
      current2RMS: 0.1,
      dutyCycle2: 0.0,
    }

    const sensorRequest = new NextRequest('http://localhost:3000/api/sensors', {
      method: 'POST',
      body: JSON.stringify(sensorData),
    })

    const sensorResponse = await sensorPost(sensorRequest)
    const sensorResult = await sensorResponse.json()

    expect(sensorResponse.status).toBe(201)
    expect(sensorResult.success).toBe(true)
    expect(mockPrisma.sensorData.create).toHaveBeenCalledWith({
      data: {
        ...sensorData,
        timestamp: new Date(parseInt(sensorData.timestamp)),
        startTime: new Date(parseInt(sensorData.startTime)),
        endTime: new Date(parseInt(sensorData.endTime)),
      },
    })

    // 2. Submit corresponding event
    const eventData = {
      device: 'well-pump-monitor',
      location: 'Pump House',
      timestamp: '1672574400000',
      type: 1, // HIGH_CURRENT
      value: 8.5,
      threshold: 7.0,
      startTime: '1672574380000',
      duration: 20000,
      active: true,
      description: 'High current detected on pump 1',
    }

    const eventRequest = new NextRequest('http://localhost:3000/api/events', {
      method: 'POST',
      body: JSON.stringify(eventData),
    })

    const eventResponse = await eventPost(eventRequest)
    const eventResult = await eventResponse.json()

    expect(eventResponse.status).toBe(201)
    expect(eventResult.success).toBe(true)
    expect(mockPrisma.event.create).toHaveBeenCalledWith({
      data: {
        ...eventData,
        type: 'HIGH_CURRENT',
        timestamp: new Date(parseInt(eventData.timestamp)),
        startTime: new Date(parseInt(eventData.startTime)),
        duration: BigInt(eventData.duration),
      },
    })

    // 3. Check system health reflects the new data
    mockPrisma.$queryRaw.mockResolvedValue([{ test: 1 }])
    mockPrisma.sensorData.findFirst.mockResolvedValue({
      id: 'sensor-1',
      timestamp: new Date('2023-01-01T11:59:00.000Z'), // Recent data
    } as any)
    mockPrisma.event.count
      .mockResolvedValueOnce(1) // Active events
      .mockResolvedValueOnce(5) // Total events
    mockPrisma.user.count.mockResolvedValue(2)

    const healthRequest = new NextRequest('http://localhost:3000/api/health')
    const healthResponse = await healthGet(healthRequest)
    const healthResult = await healthResponse.json()

    expect(healthResponse.status).toBe(200)
    expect(healthResult.status).toBe('warning') // Due to active alerts
    expect(healthResult.database).toBe('connected')
    expect(healthResult.dataIngestion).toBe('active')
    expect(healthResult.activeAlerts).toBe(1)
  })

  it('should handle missing data detection', async () => {
    // Mock old sensor data (more than 5 minutes ago)
    mockPrisma.$queryRaw.mockResolvedValue([{ test: 1 }])
    mockPrisma.sensorData.findFirst.mockResolvedValue({
      id: 'sensor-1',
      timestamp: new Date('2023-01-01T10:00:00.000Z'), // 2 hours ago
    } as any)
    mockPrisma.event.count
      .mockResolvedValueOnce(0) // No active events
      .mockResolvedValueOnce(0) // No total events
    mockPrisma.user.count.mockResolvedValue(1)

    const healthRequest = new NextRequest('http://localhost:3000/api/health')
    const healthResponse = await healthGet(healthRequest)
    const healthResult = await healthResponse.json()

    expect(healthResponse.status).toBe(200)
    expect(healthResult.status).toBe('degraded')
    expect(healthResult.dataIngestion).toBe('stale')
    expect(healthResult.lastDataReceived).toBe('2023-01-01T10:00:00.000Z')
  })

  it('should handle multiple simultaneous events', async () => {
    const baseEventData = {
      device: 'well-pump-monitor',
      location: 'Pump House',
      timestamp: '1672574400000',
      startTime: '1672574380000',
      duration: 20000,
      active: true,
    }

    // Mock multiple event creations
    mockPrisma.event.create
      .mockResolvedValueOnce({ id: 'event-1', type: 'HIGH_CURRENT' } as any)
      .mockResolvedValueOnce({ id: 'event-2', type: 'LOW_PRESSURE' } as any)

    // Submit high current event
    const highCurrentEvent = {
      ...baseEventData,
      type: 1, // HIGH_CURRENT
      value: 8.5,
      threshold: 7.0,
      description: 'High current detected',
    }

    const highCurrentRequest = new NextRequest('http://localhost:3000/api/events', {
      method: 'POST',
      body: JSON.stringify(highCurrentEvent),
    })

    const highCurrentResponse = await eventPost(highCurrentRequest)
    expect(highCurrentResponse.status).toBe(201)

    // Submit low pressure event
    const lowPressureEvent = {
      ...baseEventData,
      type: 2, // LOW_PRESSURE
      value: 32.0,
      threshold: 35.0,
      description: 'Low pressure detected',
    }

    const lowPressureRequest = new NextRequest('http://localhost:3000/api/events', {
      method: 'POST',
      body: JSON.stringify(lowPressureEvent),
    })

    const lowPressureResponse = await eventPost(lowPressureRequest)
    expect(lowPressureResponse.status).toBe(201)

    // Check that both events were created
    expect(mockPrisma.event.create).toHaveBeenCalledTimes(2)

    // Health check should show unhealthy due to multiple alerts
    mockPrisma.$queryRaw.mockResolvedValue([{ test: 1 }])
    mockPrisma.sensorData.findFirst.mockResolvedValue({
      timestamp: new Date('2023-01-01T11:59:00.000Z'),
    } as any)
    mockPrisma.event.count
      .mockResolvedValueOnce(2) // 2 active events
      .mockResolvedValueOnce(10) // Total events
    mockPrisma.user.count.mockResolvedValue(1)

    const healthRequest = new NextRequest('http://localhost:3000/api/health')
    const healthResponse = await healthGet(healthRequest)
    const healthResult = await healthResponse.json()

    expect(healthResult.status).toBe('warning') // 2 events = warning (< 5)
    expect(healthResult.activeAlerts).toBe(2)
  })

  it('should handle database errors gracefully', async () => {
    // Sensor data submission fails
    mockPrisma.sensorData.create.mockRejectedValue(new Error('Database connection failed'))

    const sensorData = {
      device: 'well-pump-monitor',
      location: 'Pump House',
      timestamp: '1672574400000',
      startTime: '1672574340000',
      endTime: '1672574400000',
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

    const sensorRequest = new NextRequest('http://localhost:3000/api/sensors', {
      method: 'POST',
      body: JSON.stringify(sensorData),
    })

    const sensorResponse = await sensorPost(sensorRequest)
    const sensorResult = await sensorResponse.json()

    expect(sensorResponse.status).toBe(500)
    expect(sensorResult.error).toBe('Internal server error')

    // Health check also fails
    mockPrisma.$queryRaw.mockRejectedValue(new Error('Database connection failed'))

    const healthRequest = new NextRequest('http://localhost:3000/api/health')
    const healthResponse = await healthGet(healthRequest)
    const healthResult = await healthResponse.json()

    expect(healthResponse.status).toBe(503)
    expect(healthResult.status).toBe('unhealthy')
    expect(healthResult.database).toBe('disconnected')
    expect(healthResult.error).toBe('Database connection failed')
  })
})