import { NextRequest } from 'next/server'
import { POST, GET, PATCH } from '@/app/api/events/route'
import { prisma } from '@/lib/prisma'
import { EventType } from '@prisma/client'

// Mock Prisma
jest.mock('@/lib/prisma', () => ({
  prisma: {
    event: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
  },
}))

const mockPrisma = prisma as jest.Mocked<typeof prisma>

describe('/api/events', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('POST', () => {
    it('should create event successfully', async () => {
      const mockEventData = {
        device: 'well-pump-monitor',
        location: 'Pump House',
        timestamp: '1640995200000',
        type: 1, // HIGH_CURRENT
        value: 8.5,
        threshold: 7.2,
        startTime: '1640995180000',
        duration: 20000,
        active: true,
        description: 'High current detected on pump 1',
      }

      mockPrisma.event.create.mockResolvedValue({
        id: 'test-event-id',
        ...mockEventData,
        type: EventType.HIGH_CURRENT,
        timestamp: new Date(parseInt(mockEventData.timestamp)),
        startTime: new Date(parseInt(mockEventData.startTime)),
        duration: BigInt(mockEventData.duration),
        acknowledged: false,
        acknowledgedAt: null,
        acknowledgedBy: null,
        createdAt: new Date(),
      })

      const request = new NextRequest('http://localhost:3000/api/events', {
        method: 'POST',
        body: JSON.stringify(mockEventData),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.success).toBe(true)
      expect(data.id).toBe('test-event-id')
    })

    it('should return 400 for invalid event type', async () => {
      const invalidEventData = {
        device: 'well-pump-monitor',
        location: 'Pump House',
        timestamp: '1640995200000',
        type: 999, // Invalid type
        value: 8.5,
        threshold: 7.2,
        startTime: '1640995180000',
        duration: 20000,
        active: true,
        description: 'Test event',
      }

      const request = new NextRequest('http://localhost:3000/api/events', {
        method: 'POST',
        body: JSON.stringify(invalidEventData),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toContain('Invalid event type')
    })

    it('should return 400 for missing required fields', async () => {
      const incompleteData = {
        device: 'well-pump-monitor',
        // Missing other required fields
      }

      const request = new NextRequest('http://localhost:3000/api/events', {
        method: 'POST',
        body: JSON.stringify(incompleteData),
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toContain('Missing required field')
    })
  })

  describe('GET', () => {
    it('should retrieve events with default pagination', async () => {
      const mockEvents = [
        {
          id: '1',
          device: 'well-pump-monitor',
          location: 'Pump House',
          timestamp: new Date(),
          type: EventType.HIGH_CURRENT,
          value: 8.5,
          threshold: 7.2,
          duration: BigInt(20000),
          active: true,
          description: 'High current detected',
        },
      ]

      mockPrisma.event.findMany.mockResolvedValue(mockEvents as any)
      mockPrisma.event.count.mockResolvedValue(1)

      const request = new NextRequest('http://localhost:3000/api/events')
      const response = await GET(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.data).toHaveLength(1)
      expect(data.data[0].duration).toBe('20000') // BigInt converted to string
      expect(data.pagination.total).toBe(1)
    })

    it('should filter by active status', async () => {
      const request = new NextRequest('http://localhost:3000/api/events?active=true')
      
      mockPrisma.event.findMany.mockResolvedValue([])
      mockPrisma.event.count.mockResolvedValue(0)

      await GET(request)

      expect(mockPrisma.event.findMany).toHaveBeenCalledWith({
        where: { active: true },
        orderBy: { timestamp: 'desc' },
        take: 100,
        skip: 0,
      })
    })

    it('should filter by event type', async () => {
      const request = new NextRequest('http://localhost:3000/api/events?type=HIGH_CURRENT')
      
      mockPrisma.event.findMany.mockResolvedValue([])
      mockPrisma.event.count.mockResolvedValue(0)

      await GET(request)

      expect(mockPrisma.event.findMany).toHaveBeenCalledWith({
        where: { type: 'HIGH_CURRENT' },
        orderBy: { timestamp: 'desc' },
        take: 100,
        skip: 0,
      })
    })
  })

  describe('PATCH', () => {
    it('should acknowledge event successfully', async () => {
      mockPrisma.event.update.mockResolvedValue({
        id: 'test-event-id',
        acknowledged: true,
        acknowledgedAt: new Date(),
      } as any)

      const request = new NextRequest('http://localhost:3000/api/events?id=test-event-id&action=acknowledge', {
        method: 'PATCH',
      })

      const response = await PATCH(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.success).toBe(true)
      expect(data.message).toContain('acknowledged')
      
      expect(mockPrisma.event.update).toHaveBeenCalledWith({
        where: { id: 'test-event-id' },
        data: {
          acknowledged: true,
          acknowledgedAt: expect.any(Date),
        },
      })
    })

    it('should return 400 for missing event ID', async () => {
      const request = new NextRequest('http://localhost:3000/api/events?action=acknowledge', {
        method: 'PATCH',
      })

      const response = await PATCH(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Event ID is required')
    })

    it('should return 400 for invalid action', async () => {
      const request = new NextRequest('http://localhost:3000/api/events?id=test-event-id&action=invalid', {
        method: 'PATCH',
      })

      const response = await PATCH(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Invalid action')
    })
  })
})