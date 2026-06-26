/**
 * @jest-environment node
 *
 * Verifies that creating a NEW active event triggers notification dispatch —
 * the missing link that previously meant Pushover notifications never sent.
 */
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/events/route'
import { prisma } from '@/lib/prisma'
import { dispatchEventNotifications } from '@/lib/notifications'
import { EventType } from '@prisma/client'

jest.mock('@/lib/prisma', () => ({
  prisma: {
    event: {
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  },
}))

jest.mock('@/lib/auth-middleware', () => ({
  getAuthContext: jest.fn().mockResolvedValue({
    isAuthenticated: true,
    user: { id: '1', username: 'tester', role: 'ADMIN' },
    authMethod: 'session',
  }),
  hasPermission: jest.fn().mockReturnValue(true),
}))

jest.mock('@/lib/notifications', () => ({
  dispatchEventNotifications: jest
    .fn()
    .mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0, results: [] }),
}))

const mockPrisma = prisma as unknown as {
  event: { create: jest.Mock; findFirst: jest.Mock; update: jest.Mock }
}
const mockDispatch = dispatchEventNotifications as jest.Mock

const baseEvent = {
  device: 'well-pump-monitor',
  location: 'Pump House',
  timestamp: '1640995200000',
  type: 2, // LOW_PRESSURE
  value: 18.2,
  threshold: 20,
  startTime: '1640995180000',
  duration: 20000,
  active: true,
  description: 'Low pressure detected',
}

function req(body: unknown) {
  return new NextRequest('http://localhost:3000/api/events', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

describe('/api/events POST notification trigger', () => {
  beforeEach(() => jest.clearAllMocks())

  it('dispatches notifications when a NEW active event is created', async () => {
    mockPrisma.event.findFirst.mockResolvedValue(null) // no existing active event
    mockPrisma.event.create.mockResolvedValue({ id: 'evt-1' })

    const response = await POST(req(baseEvent))
    expect(response.status).toBe(201)

    expect(mockDispatch).toHaveBeenCalledTimes(1)
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: EventType.LOW_PRESSURE,
        device: 'well-pump-monitor',
        value: 18.2,
      })
    )
  })

  it('does NOT re-dispatch when updating an existing active event', async () => {
    mockPrisma.event.findFirst.mockResolvedValue({ id: 'evt-existing' })
    mockPrisma.event.update.mockResolvedValue({ id: 'evt-existing' })

    const response = await POST(req(baseEvent))
    expect(response.status).toBe(200)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('does NOT dispatch when an event is resolved (active:false)', async () => {
    mockPrisma.event.findFirst.mockResolvedValue({ id: 'evt-existing' })
    mockPrisma.event.update.mockResolvedValue({ id: 'evt-existing' })

    const response = await POST(req({ ...baseEvent, active: false }))
    expect(response.status).toBe(200)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('still returns 201 even if notification dispatch throws', async () => {
    mockPrisma.event.findFirst.mockResolvedValue(null)
    mockPrisma.event.create.mockResolvedValue({ id: 'evt-2' })
    mockDispatch.mockRejectedValueOnce(new Error('pushover down'))

    const response = await POST(req(baseEvent))
    expect(response.status).toBe(201)
    expect(mockDispatch).toHaveBeenCalledTimes(1)
  })
})
