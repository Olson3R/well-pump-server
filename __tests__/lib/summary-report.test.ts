/**
 * @jest-environment node
 *
 * Tests for the scheduled summary-report path. Covers:
 *   - building the report payload (window math, formatting)
 *   - timezone-aware hour/weekday gating in the scheduler
 *   - per-user idempotency via `summaryReportLastSentAt`
 *   - "send test now" delivery shortcut
 *
 * Stats computation itself is exercised in stats.test.ts; here we just verify
 * the orchestration wires the right rows / period / recipient.
 */
import { prisma } from '@/lib/prisma'
import * as notifications from '@/lib/notifications'
import {
  buildSummaryReport,
  hourInTimezone,
  isValidTimezone,
  runDueSummaryReports,
  sendSummaryReportFor,
  weekdayInTimezone,
} from '@/lib/summary-report'

jest.mock('@/lib/prisma', () => ({
  prisma: {
    notificationSettings: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    sensorData: {
      findMany: jest.fn(),
    },
    event: {
      count: jest.fn(),
    },
  },
}))

jest.mock('@/lib/notifications', () => ({
  ...jest.requireActual('@/lib/notifications'),
  sendPushover: jest.fn(),
  getEnvPushoverCredentials: jest.fn(),
}))

const mockPrisma = prisma as unknown as DeepMocked<typeof prisma>
const mockNotifications = notifications as unknown as {
  sendPushover: jest.Mock
  getEnvPushoverCredentials: jest.Mock
}

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

beforeEach(() => {
  jest.clearAllMocks()
  // Default: no env-level Pushover, no events. Individual tests override.
  mockNotifications.getEnvPushoverCredentials.mockReturnValue(null)
  mockPrisma.event.count.mockResolvedValue(0)
})

describe('hourInTimezone / weekdayInTimezone', () => {
  it('returns the hour-of-day in the given IANA timezone', () => {
    // 2026-06-26T17:00:00Z = 13:00 in America/New_York (EDT, UTC-4)
    const date = new Date('2026-06-26T17:00:00Z')
    expect(hourInTimezone(date, 'America/New_York')).toBe(13)
    expect(hourInTimezone(date, 'UTC')).toBe(17)
  })

  it('returns the weekday in the given IANA timezone (0=Sun..6=Sat)', () => {
    // 2026-06-29 is a Monday; convert to local midnight there.
    const date = new Date('2026-06-29T05:00:00Z') // 01:00 in NY on Mon
    expect(weekdayInTimezone(date, 'America/New_York')).toBe(1)
    // Same instant is still Monday in UTC.
    expect(weekdayInTimezone(date, 'UTC')).toBe(1)
  })

  it('falls back gracefully on bogus timezone strings', () => {
    expect(isValidTimezone('America/New_York')).toBe(true)
    expect(isValidTimezone('Not/A_Real_Zone')).toBe(false)
    expect(isValidTimezone('')).toBe(false)
  })
})

describe('buildSummaryReport', () => {
  it('queries the last 24h for a daily report and formats the body', async () => {
    const now = new Date('2026-06-26T08:00:00Z')
    mockPrisma.sensorData.findMany.mockResolvedValue([
      // One pump-on minute => 1 run, 60s runtime. Sensor temps are Fahrenheit.
      {
        timestamp: new Date('2026-06-26T07:00:00Z'),
        startTime: new Date('2026-06-26T06:59:00Z'),
        endTime: new Date('2026-06-26T07:00:00Z'),
        dutyCycle1: 100,
        pressMin: 45,
        tempMin: 62.4,
        tempMax: 65.1,
        device: 'well-pump-monitor',
      },
    ])
    mockPrisma.event.count.mockResolvedValue(2)

    const report = await buildSummaryReport('day', now)

    expect(report.period).toBe('day')
    expect(report.end).toEqual(now)
    expect(report.start.getTime()).toBe(now.getTime() - DAY)
    expect(report.stats.pumpRunCount).toBe(1)
    expect(report.stats.pumpDurationSeconds).toBe(60)
    expect(report.activeAlerts).toBe(2)
    expect(report.tempMinF).toBe(62.4)
    expect(report.tempMaxF).toBe(65.1)
    expect(report.title).toMatch(/daily/i)
    expect(report.body).toContain('Last 24 hours')
    expect(report.body).toContain('Pump runs: 1')
    expect(report.body).toContain('Pump runtime: 1m')
    // Default unit is Fahrenheit (pass-through for sensor data).
    expect(report.body).toContain('Temperature: 62.4°F – 65.1°F')
    expect(report.body).toContain('Active alerts: 2')

    // Window bounds passed to Prisma match what we just asserted.
    const args = mockPrisma.sensorData.findMany.mock.calls[0][0]
    expect(args.where.timestamp.gte).toEqual(report.start)
    expect(args.where.timestamp.lte).toEqual(report.end)
  })

  it('uses a 7-day window for the weekly report', async () => {
    const now = new Date('2026-06-29T13:00:00Z') // Monday
    mockPrisma.sensorData.findMany.mockResolvedValue([])

    const report = await buildSummaryReport('week', now)

    expect(report.start.getTime()).toBe(now.getTime() - 7 * DAY)
    expect(report.title).toMatch(/weekly/i)
    expect(report.body).toContain('Last 7 days')
  })

  it('reports the coldest tempMin and hottest tempMax across rows', async () => {
    mockPrisma.sensorData.findMany.mockResolvedValue([
      {
        timestamp: new Date('2026-06-26T01:00:00Z'),
        startTime: new Date('2026-06-26T00:59:00Z'),
        endTime: new Date('2026-06-26T01:00:00Z'),
        dutyCycle1: 0,
        pressMin: 50,
        tempMin: 56.0,
        tempMax: 60.0,
        device: 'd',
      },
      {
        timestamp: new Date('2026-06-26T02:00:00Z'),
        startTime: new Date('2026-06-26T01:59:00Z'),
        endTime: new Date('2026-06-26T02:00:00Z'),
        dutyCycle1: 0,
        pressMin: 50,
        tempMin: 49.6, // coldest
        tempMax: 58.3,
        device: 'd',
      },
      {
        timestamp: new Date('2026-06-26T03:00:00Z'),
        startTime: new Date('2026-06-26T02:59:00Z'),
        endTime: new Date('2026-06-26T03:00:00Z'),
        dutyCycle1: 0,
        pressMin: 50,
        tempMin: 52.1,
        tempMax: 71.4, // hottest
        device: 'd',
      },
    ])

    // Fahrenheit is pass-through so we can assert raw aggregation directly.
    const report = await buildSummaryReport('day', undefined, { temperatureUnit: 'F' })

    expect(report.tempMinF).toBe(49.6)
    expect(report.tempMaxF).toBe(71.4)
    expect(report.body).toContain('Temperature: 49.6°F – 71.4°F')
  })

  it('renders the temperature line in the requested unit', async () => {
    mockPrisma.sensorData.findMany.mockResolvedValue([
      {
        timestamp: new Date('2026-06-26T01:00:00Z'),
        startTime: new Date('2026-06-26T00:59:00Z'),
        endTime: new Date('2026-06-26T01:00:00Z'),
        dutyCycle1: 0,
        pressMin: 50,
        tempMin: 32,  // 0°C
        tempMax: 212, // 100°C
        device: 'd',
      },
    ])

    const fahrenheit = await buildSummaryReport('day', undefined, { temperatureUnit: 'F' })
    expect(fahrenheit.body).toContain('Temperature: 32.0°F – 212.0°F')

    const celsius = await buildSummaryReport('day', undefined, { temperatureUnit: 'C' })
    expect(celsius.body).toContain('Temperature: 0.0°C – 100.0°C')
  })

  it('omits the temperature line when the window had no readings', async () => {
    mockPrisma.sensorData.findMany.mockResolvedValue([])

    const report = await buildSummaryReport('day')

    expect(report.tempMinF).toBeNull()
    expect(report.tempMaxF).toBeNull()
    expect(report.body).not.toContain('Temperature')
  })
})

describe('sendSummaryReportFor', () => {
  it('uses the user’s own Pushover credentials when they’re set', async () => {
    mockPrisma.notificationSettings.findUnique.mockResolvedValue({
      userId: 'u1',
      summaryReportPeriod: 'day',
      pushoverToken: 'utok',
      pushoverUser: 'uuser',
    })
    mockPrisma.sensorData.findMany.mockResolvedValue([])
    mockNotifications.sendPushover.mockResolvedValue({
      channel: 'pushover',
      recipient: 'user:u1',
      success: true,
    })

    const result = await sendSummaryReportFor('u1', { now: new Date('2026-06-26T08:00:00Z') })

    expect(result.delivered).toBe(true)
    expect(mockNotifications.sendPushover).toHaveBeenCalledWith(
      { token: 'utok', user: 'uuser' },
      expect.objectContaining({
        title: expect.stringMatching(/daily/i),
        eventType: 'DAILY_SUMMARY',
      }),
      'user:u1',
    )
  })

  it('falls back to env Pushover credentials when the user has none', async () => {
    mockPrisma.notificationSettings.findUnique.mockResolvedValue({
      userId: 'u1',
      summaryReportPeriod: 'day',
      pushoverToken: null,
      pushoverUser: null,
    })
    mockPrisma.sensorData.findMany.mockResolvedValue([])
    mockNotifications.getEnvPushoverCredentials.mockReturnValue({
      token: 'envtok',
      user: 'envuser',
    })
    mockNotifications.sendPushover.mockResolvedValue({
      channel: 'pushover',
      recipient: 'user:u1',
      success: true,
    })

    await sendSummaryReportFor('u1')

    expect(mockNotifications.sendPushover).toHaveBeenCalledWith(
      { token: 'envtok', user: 'envuser' },
      expect.any(Object),
      'user:u1',
    )
  })

  it('skips delivery when no Pushover credentials are available anywhere', async () => {
    mockPrisma.notificationSettings.findUnique.mockResolvedValue({
      userId: 'u1',
      summaryReportPeriod: 'day',
      pushoverToken: null,
      pushoverUser: null,
    })
    // env returns null by default.

    const result = await sendSummaryReportFor('u1')

    expect(result.delivered).toBe(false)
    expect(result.skippedReason).toMatch(/Pushover/i)
    expect(mockNotifications.sendPushover).not.toHaveBeenCalled()
  })

  it('honours an explicit period override (used by "send test now")', async () => {
    mockPrisma.notificationSettings.findUnique.mockResolvedValue({
      userId: 'u1',
      summaryReportPeriod: 'day', // saved as daily
      pushoverToken: 'utok',
      pushoverUser: 'uuser',
    })
    mockPrisma.sensorData.findMany.mockResolvedValue([])
    mockNotifications.sendPushover.mockResolvedValue({
      channel: 'pushover',
      recipient: 'user:u1',
      success: true,
    })

    const result = await sendSummaryReportFor('u1', { period: 'week' })

    expect(result.period).toBe('week')
    expect(mockNotifications.sendPushover).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ eventType: 'WEEKLY_SUMMARY' }),
      'user:u1',
    )
  })
})

describe('runDueSummaryReports', () => {
  /** Convenience builder for a fully-populated settings row in the cron path. */
  function settingsRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'ns1',
      userId: 'u1',
      summaryReportEnabled: true,
      summaryReportHourLocal: 8,
      summaryReportPeriod: 'day',
      summaryReportTimezone: 'UTC',
      summaryReportLastSentAt: null,
      pushoverToken: 'utok',
      pushoverUser: 'uuser',
      ...overrides,
    }
  }

  it('sends to a user whose configured local hour matches now (per their tz)', async () => {
    mockPrisma.notificationSettings.findMany.mockResolvedValue([
      settingsRow({ summaryReportTimezone: 'America/New_York' }),
    ])
    mockPrisma.sensorData.findMany.mockResolvedValue([])
    mockNotifications.sendPushover.mockResolvedValue({
      channel: 'pushover',
      recipient: 'user:u1',
      success: true,
    })
    // 12:00Z = 08:00 NY (EDT) — matches hour 8.
    const now = new Date('2026-06-26T12:00:00Z')

    const results = await runDueSummaryReports(now)

    expect(results).toHaveLength(1)
    expect(results[0].delivered).toBe(true)
    expect(mockNotifications.sendPushover).toHaveBeenCalled()
    // Bookkeeping write so the next tick doesn't double-send.
    expect(mockPrisma.notificationSettings.update).toHaveBeenCalledWith({
      where: { id: 'ns1' },
      data: { summaryReportLastSentAt: now },
    })
  })

  it('skips users whose local hour does not match the current hour', async () => {
    mockPrisma.notificationSettings.findMany.mockResolvedValue([
      settingsRow({ summaryReportHourLocal: 9 }),
    ])
    const now = new Date('2026-06-26T08:00:00Z') // hour=8 in UTC

    const results = await runDueSummaryReports(now)

    expect(results).toEqual([])
    expect(mockNotifications.sendPushover).not.toHaveBeenCalled()
  })

  it('only fires the weekly report on Mondays', async () => {
    mockPrisma.notificationSettings.findMany.mockResolvedValue([
      settingsRow({ summaryReportPeriod: 'week' }),
    ])
    // 2026-06-26 is a Friday in UTC.
    const friday = new Date('2026-06-26T08:00:00Z')
    const fridayResults = await runDueSummaryReports(friday)
    expect(fridayResults).toEqual([])

    // 2026-06-29 is the next Monday.
    mockPrisma.sensorData.findMany.mockResolvedValue([])
    mockNotifications.sendPushover.mockResolvedValue({
      channel: 'pushover',
      recipient: 'user:u1',
      success: true,
    })
    const monday = new Date('2026-06-29T08:00:00Z')
    const mondayResults = await runDueSummaryReports(monday)
    expect(mondayResults).toHaveLength(1)
    expect(mondayResults[0].delivered).toBe(true)
  })

  it('refuses to send a second daily report within the idempotency window', async () => {
    const now = new Date('2026-06-26T08:00:00Z')
    mockPrisma.notificationSettings.findMany.mockResolvedValue([
      settingsRow({
        // Sent 2h ago — well inside the 23h cool-down.
        summaryReportLastSentAt: new Date(now.getTime() - 2 * HOUR),
      }),
    ])

    const results = await runDueSummaryReports(now)

    expect(results).toEqual([])
    expect(mockNotifications.sendPushover).not.toHaveBeenCalled()
  })

  it('does not mark a failed delivery as sent (so the next tick retries)', async () => {
    mockPrisma.notificationSettings.findMany.mockResolvedValue([settingsRow()])
    mockPrisma.sensorData.findMany.mockResolvedValue([])
    mockNotifications.sendPushover.mockResolvedValue({
      channel: 'pushover',
      recipient: 'user:u1',
      success: false,
      error: 'pushover 500',
    })
    const now = new Date('2026-06-26T08:00:00Z')

    const results = await runDueSummaryReports(now)

    expect(results[0].delivered).toBe(false)
    expect(mockPrisma.notificationSettings.update).not.toHaveBeenCalled()
  })
})
