/**
 * @jest-environment node
 *
 * Tests for GET /api/stats. The heavy lifting is a single SQL aggregation, so
 * here we mock `$queryRaw` and verify: auth gating, param validation, that the
 * filters/thresholds are bound into the query, BigInt/Decimal coercion, the
 * response shape (including derived fields), and error handling.
 */
import { NextRequest } from 'next/server'
import { GET } from '@/app/api/stats/route'
import { prisma } from '@/lib/prisma'
import { hasPermission } from '@/lib/auth-middleware'

jest.mock('@/lib/prisma', () => ({
  prisma: {
    $queryRaw: jest.fn(),
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

const mockPrisma = prisma as unknown as { $queryRaw: jest.Mock }
const mockHasPermission = hasPermission as jest.Mock

const url = (qs = '') => `http://localhost:3000/api/stats${qs}`

/** A representative aggregate row as Postgres/Prisma would return it. */
function aggregateRow(overrides: Record<string, unknown> = {}) {
  return [
    {
      pump_run_count: BigInt(12), // COUNT => BigInt
      pump_duration_seconds: 3600, // SUM => number
      low_pressure_count: BigInt(2),
      low_pressure_duration_seconds: 600,
      sample_count: BigInt(1440),
      ...overrides,
    },
  ]
}

/** Flatten the bound parameter values from the Prisma.Sql passed to $queryRaw. */
function boundValues(): unknown[] {
  const arg = mockPrisma.$queryRaw.mock.calls[0][0] as { values?: unknown[] }
  return arg?.values ?? []
}

describe('GET /api/stats', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockHasPermission.mockReturnValue(true)
  })

  it('returns 401 when the caller lacks the sensors permission', async () => {
    mockHasPermission.mockReturnValue(false)

    const response = await GET(new NextRequest(url()))
    const data = await response.json()

    expect(response.status).toBe(401)
    expect(data.error).toBe('Unauthorized')
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled()
  })

  it('computes stats and coerces BigInt/number aggregate values', async () => {
    mockPrisma.$queryRaw.mockResolvedValue(aggregateRow())

    const response = await GET(new NextRequest(url()))
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1)
    expect(data.stats).toEqual({
      pumpRunCount: 12,
      pumpDurationSeconds: 3600,
      pumpDurationMs: 3_600_000,
      lowPressureEventCount: 2,
      lowPressureDurationSeconds: 600,
      lowPressureDurationMs: 600_000,
      sampleCount: 1440,
      averagePumpRunSeconds: 300, // 3600 / 12
      averageLowPressureSeconds: 300, // 600 / 2
    })
  })

  it('coerces Decimal-as-string sums returned by some drivers', async () => {
    mockPrisma.$queryRaw.mockResolvedValue(
      aggregateRow({ pump_duration_seconds: '180.5', pump_run_count: BigInt(1) })
    )

    const response = await GET(new NextRequest(url()))
    const data = await response.json()

    expect(data.stats.pumpDurationSeconds).toBe(180.5)
    expect(data.stats.pumpDurationMs).toBe(180_500)
  })

  it('defaults to all-zero stats when the table is empty', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        pump_run_count: BigInt(0),
        pump_duration_seconds: 0,
        low_pressure_count: BigInt(0),
        low_pressure_duration_seconds: 0,
        sample_count: BigInt(0),
      },
    ])

    const response = await GET(new NextRequest(url()))
    const data = await response.json()

    expect(data.stats.pumpRunCount).toBe(0)
    expect(data.stats.averagePumpRunSeconds).toBe(0)
    expect(data.stats.averageLowPressureSeconds).toBe(0)
  })

  it('echoes the default thresholds when none are supplied', async () => {
    mockPrisma.$queryRaw.mockResolvedValue(aggregateRow())

    const response = await GET(new NextRequest(url()))
    const data = await response.json()

    expect(data.thresholds).toEqual({ dutyCycleThreshold: 0, pressureThreshold: 30 })
  })

  it('binds date range, device and custom thresholds into the query', async () => {
    mockPrisma.$queryRaw.mockResolvedValue(aggregateRow())

    const startDate = '2026-01-01T00:00:00.000Z'
    const endDate = '2026-02-01T00:00:00.000Z'
    const response = await GET(
      new NextRequest(
        url(
          `?startDate=${startDate}&endDate=${endDate}&device=well-pump-monitor` +
            `&dutyCycleThreshold=0.05&pressureThreshold=25`
        )
      )
    )
    const data = await response.json()

    const values = boundValues()
    // Thresholds appear first (in the CTE), then the WHERE bindings.
    expect(values).toContain(0.05)
    expect(values).toContain(25)
    expect(values).toContain('well-pump-monitor')
    expect(values.some((v) => v instanceof Date && v.toISOString() === startDate)).toBe(true)
    expect(values.some((v) => v instanceof Date && v.toISOString() === endDate)).toBe(true)

    expect(data.range).toEqual({
      startDate,
      endDate,
      device: 'well-pump-monitor',
    })
    expect(data.thresholds).toEqual({ dutyCycleThreshold: 0.05, pressureThreshold: 25 })
  })

  it('does not bind a device filter when none is given', async () => {
    mockPrisma.$queryRaw.mockResolvedValue(aggregateRow())

    await GET(new NextRequest(url()))

    // Only the two thresholds should be bound — no date/device params.
    expect(boundValues()).toEqual([0, 30])
  })

  describe('validation', () => {
    it('rejects an invalid startDate', async () => {
      const response = await GET(new NextRequest(url('?startDate=not-a-date')))
      const data = await response.json()
      expect(response.status).toBe(400)
      expect(data.error).toContain('Invalid startDate')
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled()
    })

    it('rejects an invalid endDate', async () => {
      const response = await GET(new NextRequest(url('?endDate=nope')))
      const data = await response.json()
      expect(response.status).toBe(400)
      expect(data.error).toContain('Invalid endDate')
    })

    it('rejects a start after end', async () => {
      const response = await GET(
        new NextRequest(
          url('?startDate=2026-02-01T00:00:00.000Z&endDate=2026-01-01T00:00:00.000Z')
        )
      )
      const data = await response.json()
      expect(response.status).toBe(400)
      expect(data.error).toContain('startDate must be before endDate')
    })

    it('rejects a negative dutyCycleThreshold', async () => {
      const response = await GET(new NextRequest(url('?dutyCycleThreshold=-1')))
      const data = await response.json()
      expect(response.status).toBe(400)
      expect(data.error).toContain('Invalid dutyCycleThreshold')
    })

    it('rejects a non-numeric pressureThreshold', async () => {
      const response = await GET(new NextRequest(url('?pressureThreshold=abc')))
      const data = await response.json()
      expect(response.status).toBe(400)
      expect(data.error).toContain('Invalid pressureThreshold')
    })
  })

  it('returns 500 on database errors', async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error('Database error'))

    const response = await GET(new NextRequest(url()))
    const data = await response.json()

    expect(response.status).toBe(500)
    expect(data.error).toBe('Internal server error')
  })
})
