import { NextRequest } from 'next/server'
import { POST, GET } from '@/app/api/sensors/route'
import { prisma } from '@/lib/prisma'

// Mock Prisma
jest.mock('@/lib/prisma', () => ({
  prisma: {
    sensorData: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}))

const mockPrisma = prisma as jest.Mocked<typeof prisma>

describe('/api/sensors', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('POST', () => {
    it('should create sensor data successfully', async () => {
      const mockSensorData = {
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

      mockPrisma.sensorData.create.mockResolvedValue({
        id: 'test-id',
        ...mockSensorData,
        timestamp: new Date(parseInt(mockSensorData.timestamp)),
        startTime: new Date(parseInt(mockSensorData.startTime)),
        endTime: new Date(parseInt(mockSensorData.endTime)),
        createdAt: new Date(),
      })

      const request = new NextRequest('http://localhost:3000/api/sensors', {
        method: 'POST',
        body: JSON.stringify(mockSensorData),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.success).toBe(true)
      expect(data.id).toBe('test-id')
      expect(mockPrisma.sensorData.create).toHaveBeenCalledWith({
        data: {
          ...mockSensorData,
          timestamp: new Date(parseInt(mockSensorData.timestamp)),
          startTime: new Date(parseInt(mockSensorData.startTime)),
          endTime: new Date(parseInt(mockSensorData.endTime)),
        },
      })
    })

    it('should return 400 for missing required fields', async () => {
      const incompleteData = {
        device: 'well-pump-monitor',
        // Missing other required fields
      }

      const request = new NextRequest('http://localhost:3000/api/sensors', {
        method: 'POST',
        body: JSON.stringify(incompleteData),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toContain('Missing required field')
    })

    it('should handle database errors', async () => {
      const mockSensorData = {
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

      mockPrisma.sensorData.create.mockRejectedValue(new Error('Database error'))

      const request = new NextRequest('http://localhost:3000/api/sensors', {
        method: 'POST',
        body: JSON.stringify(mockSensorData),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(500)
      expect(data.error).toBe('Internal server error')
    })
  })

  describe('GET', () => {
    it('should retrieve sensor data with default pagination', async () => {
      const mockData = [
        {
          id: '1',
          device: 'well-pump-monitor',
          location: 'Pump House',
          timestamp: new Date(),
          tempAvg: 20.0,
          current1Avg: 2.5,
          current2Avg: 0.1,
          pressAvg: 40.0,
          humAvg: 65.0,
        },
      ]

      mockPrisma.sensorData.findMany.mockResolvedValue(mockData as any)
      mockPrisma.sensorData.count.mockResolvedValue(1)

      const request = new NextRequest('http://localhost:3000/api/sensors')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.data).toEqual(mockData)
      expect(data.pagination.total).toBe(1)
      expect(data.pagination.limit).toBe(100)
      expect(data.pagination.offset).toBe(0)
    })

    it('should filter by device', async () => {
      const request = new NextRequest('http://localhost:3000/api/sensors?device=test-device')
      
      mockPrisma.sensorData.findMany.mockResolvedValue([])
      mockPrisma.sensorData.count.mockResolvedValue(0)

      await GET(request)

      expect(mockPrisma.sensorData.findMany).toHaveBeenCalledWith({
        where: { device: 'test-device' },
        orderBy: { timestamp: 'desc' },
        take: 100,
        skip: 0,
      })
    })

    it('should filter by date range', async () => {
      const startDate = '2023-01-01T00:00:00.000Z'
      const endDate = '2023-01-02T00:00:00.000Z'
      const request = new NextRequest(
        `http://localhost:3000/api/sensors?startDate=${startDate}&endDate=${endDate}`
      )
      
      mockPrisma.sensorData.findMany.mockResolvedValue([])
      mockPrisma.sensorData.count.mockResolvedValue(0)

      await GET(request)

      expect(mockPrisma.sensorData.findMany).toHaveBeenCalledWith({
        where: {
          timestamp: {
            gte: new Date(startDate),
            lte: new Date(endDate),
          },
        },
        orderBy: { timestamp: 'desc' },
        take: 100,
        skip: 0,
      })
    })

    it('should handle database errors during retrieval', async () => {
      mockPrisma.sensorData.findMany.mockRejectedValue(new Error('Database error'))

      const request = new NextRequest('http://localhost:3000/api/sensors')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(500)
      expect(data.error).toBe('Internal server error')
    })
  })
})