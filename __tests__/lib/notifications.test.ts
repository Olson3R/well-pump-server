/**
 * @jest-environment node
 *
 * Unit tests for the centralised notification dispatch library. These run in
 * the Node environment so `fetch`/`Response` behave like the runtime.
 */

import {
  sendPushover,
  getEnvPushoverCredentials,
  validateNotificationConfig,
  dispatchNotifications,
  dispatchEventNotifications,
} from '@/lib/notifications'
import { prisma } from '@/lib/prisma'

// --- Mocks -----------------------------------------------------------------

jest.mock('@/lib/prisma', () => ({
  prisma: {
    notificationSettings: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}))

jest.mock('web-push', () => ({
  __esModule: true,
  default: {
    setVapidDetails: jest.fn(),
    sendNotification: jest.fn(),
  },
}))

const mockPrisma = prisma as unknown as {
  notificationSettings: {
    findMany: jest.Mock
    findUnique: jest.Mock
    update: jest.Mock
  }
}

const mockFetch = jest.fn()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(global as any).fetch = mockFetch

/** Build a fake Pushover JSON response. */
function pushoverResponse(
  status: number,
  json: Record<string, unknown>
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Bad Request',
    json: async () => json,
    text: async () => JSON.stringify(json),
  } as unknown as Response
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  jest.clearAllMocks()
  process.env = { ...ORIGINAL_ENV }
  delete process.env.PUSHOVER_TOKEN
  delete process.env.PUSHOVER_USER
  delete process.env.VAPID_PUBLIC_KEY
  delete process.env.VAPID_PRIVATE_KEY
  mockPrisma.notificationSettings.findMany.mockResolvedValue([])
})

afterAll(() => {
  process.env = ORIGINAL_ENV
})

// --- sendPushover ----------------------------------------------------------

describe('sendPushover', () => {
  const creds = { token: 'app-token-123', user: 'user-key-456' }

  it('sends a form-encoded request and reports success on status:1', async () => {
    mockFetch.mockResolvedValue(
      pushoverResponse(200, { status: 1, request: 'req-abc' })
    )

    const result = await sendPushover(creds, {
      eventType: 'LOW_PRESSURE',
      title: 'Low Pressure',
      body: 'Pressure dropped',
    })

    expect(result.success).toBe(true)
    expect(result.requestId).toBe('req-abc')
    expect(result.channel).toBe('pushover')

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.pushover.net/1/messages.json')
    expect(init.method).toBe('POST')
    // Critical: Pushover requires form-encoding, NOT application/json.
    expect(init.headers['Content-Type']).toBe(
      'application/x-www-form-urlencoded'
    )

    // Body is URL-encoded and carries the credentials + message.
    const params = new URLSearchParams(init.body as string)
    expect(params.get('token')).toBe('app-token-123')
    expect(params.get('user')).toBe('user-key-456')
    expect(params.get('message')).toBe('Pressure dropped')
    expect(params.get('title')).toBe('Low Pressure')
    expect(params.get('priority')).toBe('0')
  })

  it('uses priority 1 for high-priority event types', async () => {
    mockFetch.mockResolvedValue(
      pushoverResponse(200, { status: 1, request: 'req-1' })
    )

    await sendPushover(creds, {
      eventType: 'SENSOR_ERROR',
      title: 'Sensor Error',
      body: 'Sensor offline',
    })

    const params = new URLSearchParams(mockFetch.mock.calls[0][1].body as string)
    expect(params.get('priority')).toBe('1')
  })

  it('reports failure and surfaces Pushover errors on status:0', async () => {
    mockFetch.mockResolvedValue(
      pushoverResponse(400, {
        status: 0,
        errors: ['user identifier is invalid'],
        request: 'req-err',
      })
    )

    const result = await sendPushover(creds, {
      eventType: 'LOW_PRESSURE',
      title: 'Low Pressure',
      body: 'Pressure dropped',
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('user identifier is invalid')
    expect(result.requestId).toBe('req-err')
  })

  it('reports failure (not a throw) on network errors', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))

    const result = await sendPushover(creds, {
      eventType: 'LOW_PRESSURE',
      title: 'Low Pressure',
      body: 'Pressure dropped',
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('ECONNREFUSED')
  })

  it('treats a 200 body with status:0 as a failure', async () => {
    mockFetch.mockResolvedValue(
      pushoverResponse(200, { status: 0, errors: ['nope'], request: 'r' })
    )

    const result = await sendPushover(creds, {
      eventType: 'LOW_PRESSURE',
      title: 'x',
      body: 'y',
    })
    expect(result.success).toBe(false)
  })
})

// --- getEnvPushoverCredentials --------------------------------------------

describe('getEnvPushoverCredentials', () => {
  it('returns null when env vars are unset', () => {
    expect(getEnvPushoverCredentials()).toBeNull()
  })

  it('returns null when only one var is set', () => {
    process.env.PUSHOVER_TOKEN = 'tok'
    expect(getEnvPushoverCredentials()).toBeNull()
  })

  it('returns trimmed credentials when both are set', () => {
    process.env.PUSHOVER_TOKEN = ' tok '
    process.env.PUSHOVER_USER = ' usr '
    expect(getEnvPushoverCredentials()).toEqual({ token: 'tok', user: 'usr' })
  })
})

// --- validateNotificationConfig -------------------------------------------

describe('validateNotificationConfig', () => {
  it('flags missing web-push and partial pushover config', () => {
    process.env.PUSHOVER_TOKEN = 'tok'
    // PUSHOVER_USER intentionally missing -> partial config warning.
    const result = validateNotificationConfig()
    expect(result.webPush).toBe(false)
    expect(result.pushoverEnv).toBe(false)
    expect(result.warnings.some((w) => w.includes('Pushover env partially'))).toBe(
      true
    )
  })

  it('reports healthy config when fully set', () => {
    process.env.PUSHOVER_TOKEN = 'tok'
    process.env.PUSHOVER_USER = 'usr'
    process.env.VAPID_PUBLIC_KEY = 'pub'
    process.env.VAPID_PRIVATE_KEY = 'priv'
    const result = validateNotificationConfig()
    expect(result.webPush).toBe(true)
    expect(result.pushoverEnv).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })
})

// --- dispatchNotifications -------------------------------------------------

describe('dispatchNotifications', () => {
  it('sends via env credentials when no DB settings exist', async () => {
    process.env.PUSHOVER_TOKEN = 'env-tok'
    process.env.PUSHOVER_USER = 'env-usr'
    mockPrisma.notificationSettings.findMany.mockResolvedValue([])
    mockFetch.mockResolvedValue(
      pushoverResponse(200, { status: 1, request: 'req' })
    )

    const summary = await dispatchNotifications({
      eventType: 'LOW_PRESSURE',
      title: 'Low Pressure',
      body: 'Pressure dropped',
    })

    expect(summary.succeeded).toBe(1)
    expect(summary.failed).toBe(0)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const params = new URLSearchParams(mockFetch.mock.calls[0][1].body as string)
    expect(params.get('token')).toBe('env-tok')
  })

  it('does not send Pushover when nothing is configured', async () => {
    mockPrisma.notificationSettings.findMany.mockResolvedValue([])
    const summary = await dispatchNotifications({
      eventType: 'LOW_PRESSURE',
      title: 'x',
      body: 'y',
    })
    expect(summary.attempted).toBe(0)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('sends to each enabled user and honours per-type preferences', async () => {
    mockPrisma.notificationSettings.findMany.mockResolvedValue([
      {
        id: 's1',
        userId: 'u1',
        pushoverEnabled: true,
        pushoverToken: 'tok1',
        pushoverUser: 'usr1',
        lowPressureAlert: true,
      },
      {
        id: 's2',
        userId: 'u2',
        pushoverEnabled: true,
        pushoverToken: 'tok2',
        pushoverUser: 'usr2',
        lowPressureAlert: false, // opted out of this alert type
      },
    ])
    mockFetch.mockResolvedValue(
      pushoverResponse(200, { status: 1, request: 'req' })
    )

    const summary = await dispatchNotifications({
      eventType: 'LOW_PRESSURE',
      title: 'Low Pressure',
      body: 'Pressure dropped',
    })

    // Only u1 should receive it (u2 opted out).
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(summary.succeeded).toBe(1)
    const params = new URLSearchParams(mockFetch.mock.calls[0][1].body as string)
    expect(params.get('token')).toBe('tok1')
  })

  it('de-duplicates a user whose creds equal the env creds', async () => {
    process.env.PUSHOVER_TOKEN = 'shared-tok'
    process.env.PUSHOVER_USER = 'shared-usr'
    mockPrisma.notificationSettings.findMany.mockResolvedValue([
      {
        id: 's1',
        userId: 'u1',
        pushoverEnabled: true,
        pushoverToken: 'shared-tok',
        pushoverUser: 'shared-usr',
        highCurrentAlert: true,
      },
    ])
    mockFetch.mockResolvedValue(
      pushoverResponse(200, { status: 1, request: 'req' })
    )

    const summary = await dispatchNotifications({
      eventType: 'HIGH_CURRENT',
      title: 'High Current',
      body: 'Too much current',
    })

    // Same destination must only be messaged once.
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(summary.attempted).toBe(1)
  })

  it('still sends via env when loading DB settings throws', async () => {
    process.env.PUSHOVER_TOKEN = 'env-tok'
    process.env.PUSHOVER_USER = 'env-usr'
    mockPrisma.notificationSettings.findMany.mockRejectedValue(
      new Error('db down')
    )
    mockFetch.mockResolvedValue(
      pushoverResponse(200, { status: 1, request: 'req' })
    )

    const summary = await dispatchNotifications({
      eventType: 'SYSTEM_ERROR',
      title: 'System Error',
      body: 'boom',
    })

    expect(summary.succeeded).toBe(1)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

// --- dispatchEventNotifications -------------------------------------------

describe('dispatchEventNotifications', () => {
  it('builds a sensible payload from an event and dispatches it', async () => {
    process.env.PUSHOVER_TOKEN = 'env-tok'
    process.env.PUSHOVER_USER = 'env-usr'
    mockFetch.mockResolvedValue(
      pushoverResponse(200, { status: 1, request: 'req' })
    )

    const summary = await dispatchEventNotifications({
      type: 'LOW_PRESSURE',
      device: 'well-pump-monitor',
      location: 'Pump House',
      value: 18.2,
      threshold: 20,
      description: 'Pressure 18.2 psi below threshold 20 psi',
    })

    expect(summary.succeeded).toBe(1)
    const params = new URLSearchParams(mockFetch.mock.calls[0][1].body as string)
    expect(params.get('title')).toBe('Low Pressure Alert')
    expect(params.get('message')).toContain('Pressure 18.2 psi')
  })
})
