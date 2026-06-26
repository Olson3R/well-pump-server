/**
 * Centralised notification dispatch.
 *
 * This module is the single place that actually *sends* notifications (web-push
 * and Pushover). Previously the Pushover code lived inline inside the
 * `/api/notifications/send` route and — critically — nothing ever called that
 * route, so notifications never went out. The dispatch logic now lives here so
 * it can be triggered directly from the event-ingestion path (see
 * `src/app/api/events/route.ts`) as well as from the manual send/test routes.
 *
 * Design goals:
 *  - Notifications must ACTUALLY dispatch. The HTTP call to Pushover uses the
 *    documented `application/x-www-form-urlencoded` encoding which every
 *    Pushover client/library uses and which avoids the subtle failures seen
 *    when posting JSON.
 *  - Credentials resolve from per-user settings first, then fall back to the
 *    `PUSHOVER_TOKEN` / `PUSHOVER_USER` environment variables. This means a
 *    self-hosted single-user deployment that only set the env vars (the most
 *    common setup) still receives alerts even without a DB settings row.
 *  - Every attempt is logged on BOTH success and failure, with the Pushover
 *    request id, so delivery problems are observable instead of silently
 *    swallowed.
 *  - Configuration is validated at startup (see `validateNotificationConfig`).
 */

import webpush from 'web-push'
import { prisma } from '@/lib/prisma'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Event types that can produce a notification. Mirrors the Prisma `EventType`. */
export type NotificationEventType =
  | 'HIGH_CURRENT'
  | 'LOW_PRESSURE'
  | 'LOW_TEMPERATURE'
  | 'SENSOR_ERROR'
  | 'SYSTEM_ERROR'
  | 'MISSING_DATA'
  | 'LONG_PUMP_RUN'
  | 'PRESSURE_DROP'

export interface NotificationPayload {
  /** Event type used to honour each user's per-type alert preferences. */
  eventType: NotificationEventType | string
  title: string
  body: string
  /** Arbitrary structured data forwarded to the web-push client. */
  data?: Record<string, unknown>
}

export interface PushoverCredentials {
  token: string
  user: string
}

export interface ChannelResult {
  channel: 'pushover' | 'webpush'
  /** Stable identifier for the recipient (user id, or "env" for env creds). */
  recipient: string
  success: boolean
  error?: string
  /** Pushover request id when available — useful for support/debugging. */
  requestId?: string
}

export interface DispatchSummary {
  eventType: string
  attempted: number
  succeeded: number
  failed: number
  results: ChannelResult[]
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

const PUSHOVER_API_URL = 'https://api.pushover.net/1/messages.json'

/**
 * Map an event type to the boolean preference column that gates it. Event types
 * without a dedicated column (e.g. SYSTEM_ERROR) are always allowed through.
 */
const ALERT_PREFERENCE_FIELD: Record<string, string | undefined> = {
  HIGH_CURRENT: 'highCurrentAlert',
  LOW_PRESSURE: 'lowPressureAlert',
  LOW_TEMPERATURE: 'lowTemperatureAlert',
  SENSOR_ERROR: 'sensorErrorAlert',
  MISSING_DATA: 'missingDataAlert',
  LONG_PUMP_RUN: 'longRunAlert',
  PRESSURE_DROP: 'pressureDropAlert',
  // SYSTEM_ERROR intentionally absent -> always notify.
}

/** Higher-priority event types get Pushover priority 1 (bypasses quiet hours). */
const HIGH_PRIORITY_EVENTS = new Set(['SENSOR_ERROR', 'SYSTEM_ERROR'])

/**
 * Read Pushover credentials from the environment, if both are present and
 * non-empty. Returns null when env-level Pushover is not configured.
 */
export function getEnvPushoverCredentials(): PushoverCredentials | null {
  const token = process.env.PUSHOVER_TOKEN?.trim()
  const user = process.env.PUSHOVER_USER?.trim()
  if (token && user) return { token, user }
  return null
}

/** True when web-push VAPID keys are configured. */
export function isWebPushConfigured(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
}

let vapidConfigured = false

/** Lazily configure web-push VAPID details exactly once. */
function ensureVapidConfigured(): boolean {
  if (vapidConfigured) return true
  if (!isWebPushConfigured()) return false
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@wellpump.local',
    process.env.VAPID_PUBLIC_KEY as string,
    process.env.VAPID_PRIVATE_KEY as string
  )
  vapidConfigured = true
  return true
}

/**
 * Validate notification configuration. Intended to be called once at startup so
 * misconfiguration is visible in the logs immediately rather than discovered
 * when an alert silently fails to send.
 */
export function validateNotificationConfig(): {
  webPush: boolean
  pushoverEnv: boolean
  warnings: string[]
} {
  const warnings: string[] = []
  const webPush = isWebPushConfigured()
  const pushoverEnv = getEnvPushoverCredentials() !== null

  if (!webPush) {
    warnings.push(
      'Web-push disabled: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set.'
    )
  }
  // Flag a half-configured Pushover env (one var set without the other).
  const tokenSet = Boolean(process.env.PUSHOVER_TOKEN?.trim())
  const userSet = Boolean(process.env.PUSHOVER_USER?.trim())
  if (tokenSet !== userSet) {
    warnings.push(
      'Pushover env partially configured: set BOTH PUSHOVER_TOKEN and PUSHOVER_USER (or neither).'
    )
  }

  console.log(
    `[notifications] config: web-push=${webPush ? 'on' : 'off'}, ` +
      `pushover-env=${pushoverEnv ? 'on' : 'off'}`
  )
  for (const w of warnings) console.warn(`[notifications] ${w}`)

  return { webPush, pushoverEnv, warnings }
}

// ---------------------------------------------------------------------------
// Pushover
// ---------------------------------------------------------------------------

/**
 * Send a single Pushover message. Uses form-encoded parameters (the format the
 * Pushover API documents and all official examples use) and parses the JSON
 * response so we can surface the real status/errors instead of guessing.
 *
 * @param recipient - identifier used only for logging.
 */
export async function sendPushover(
  credentials: PushoverCredentials,
  payload: NotificationPayload,
  recipient = 'env'
): Promise<ChannelResult> {
  const priority = HIGH_PRIORITY_EVENTS.has(String(payload.eventType)) ? 1 : 0

  const params = new URLSearchParams({
    token: credentials.token,
    user: credentials.user,
    title: payload.title,
    // Pushover requires a non-empty message.
    message: payload.body || payload.title || 'Well pump alert',
    priority: String(priority),
  })

  const baseUrl = process.env.NEXTAUTH_URL?.replace(/\/$/, '')
  if (baseUrl) {
    params.set('url', `${baseUrl}/alerts`)
    params.set('url_title', 'View Alerts')
  }

  try {
    const response = await fetch(PUSHOVER_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })

    // Pushover always returns JSON with `status` (1 = ok) and a `request` id.
    let json: { status?: number; request?: string; errors?: string[] } = {}
    try {
      json = await response.json()
    } catch {
      // Non-JSON body (e.g. gateway error) — fall back to status text.
    }

    const ok = response.ok && json.status === 1
    if (ok) {
      console.log(
        `[notifications] pushover sent ok recipient=${recipient} ` +
          `event=${payload.eventType} request=${json.request ?? 'n/a'}`
      )
      return {
        channel: 'pushover',
        recipient,
        success: true,
        requestId: json.request,
      }
    }

    const errorMsg =
      json.errors?.join('; ') || `HTTP ${response.status} ${response.statusText}`
    console.error(
      `[notifications] pushover FAILED recipient=${recipient} ` +
        `event=${payload.eventType} status=${response.status} ` +
        `request=${json.request ?? 'n/a'} errors=${errorMsg}`
    )
    return {
      channel: 'pushover',
      recipient,
      success: false,
      error: errorMsg,
      requestId: json.request,
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(
      `[notifications] pushover network error recipient=${recipient} ` +
        `event=${payload.eventType}: ${errorMsg}`
    )
    return { channel: 'pushover', recipient, success: false, error: errorMsg }
  }
}

// ---------------------------------------------------------------------------
// Recipient resolution
// ---------------------------------------------------------------------------

interface PushoverRecipient {
  credentials: PushoverCredentials
  recipient: string
}

type SettingsRow = {
  id: string
  userId: string
  pushoverEnabled: boolean
  pushoverToken: string | null
  pushoverUser: string | null
} & Record<string, unknown>

/**
 * Build the de-duplicated list of Pushover recipients for an event type:
 *  - every user with Pushover enabled and the matching alert preference on,
 *    using their own creds (falling back to env creds if theirs are blank);
 *  - plus the env-level credentials as a standalone recipient when configured,
 *    so a deployment that only set env vars still gets alerts.
 *
 * De-duplication is by `token:user` so the same destination is never messaged
 * twice for one event.
 */
function resolvePushoverRecipients(
  settingsRows: SettingsRow[],
  envCreds: PushoverCredentials | null,
  eventType: string
): PushoverRecipient[] {
  const seen = new Set<string>()
  const recipients: PushoverRecipient[] = []

  const add = (creds: PushoverCredentials | null, recipient: string) => {
    if (!creds) return
    const key = `${creds.token}:${creds.user}`
    if (seen.has(key)) return
    seen.add(key)
    recipients.push({ credentials: creds, recipient })
  }

  for (const row of settingsRows) {
    if (!row.pushoverEnabled) continue
    if (!isAlertEnabledForType(row, eventType)) continue
    const creds =
      row.pushoverToken && row.pushoverUser
        ? { token: row.pushoverToken, user: row.pushoverUser }
        : envCreds
    add(creds, `user:${row.userId}`)
  }

  // Always include the env destination when configured.
  add(envCreds, 'env')

  return recipients
}

/** Honour a user's per-type alert preference (default allow if column absent). */
function isAlertEnabledForType(row: Record<string, unknown>, eventType: string): boolean {
  const field = ALERT_PREFERENCE_FIELD[eventType]
  if (!field) return true // no dedicated preference -> always allow
  // Default to true when the column is undefined to avoid silently dropping.
  return row[field] !== false
}

// ---------------------------------------------------------------------------
// Web-push
// ---------------------------------------------------------------------------

async function sendWebPushNotifications(
  payload: NotificationPayload,
  eventType: string
): Promise<ChannelResult[]> {
  if (!ensureVapidConfigured()) return []

  const settings = await prisma.notificationSettings.findMany({
    where: {
      pushEnabled: true,
      pushEndpoint: { not: null },
      ...alertTypeWhere(eventType),
    },
  })

  const results = await Promise.all(
    settings.map(async (s): Promise<ChannelResult | null> => {
      if (!s.pushEndpoint || !s.pushKeys) return null
      const subscription = {
        endpoint: s.pushEndpoint,
        keys: s.pushKeys as { p256dh: string; auth: string },
      }
      try {
        await webpush.sendNotification(
          subscription,
          JSON.stringify({
            title: payload.title,
            body: payload.body,
            icon: '/icons/icon-192x192.png',
            badge: '/icons/icon-72x72.png',
            data: { ...payload.data, url: '/alerts' },
          })
        )
        console.log(`[notifications] webpush sent ok recipient=user:${s.userId}`)
        return { channel: 'webpush', recipient: `user:${s.userId}`, success: true }
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode
        const errorMsg = error instanceof Error ? error.message : String(error)
        console.error(
          `[notifications] webpush FAILED recipient=user:${s.userId} ` +
            `status=${statusCode ?? 'n/a'}: ${errorMsg}`
        )
        // Expired/invalid subscription -> disable so we stop retrying it.
        if (statusCode === 404 || statusCode === 410) {
          try {
            await prisma.notificationSettings.update({
              where: { id: s.id },
              data: { pushEnabled: false, pushEndpoint: null, pushKeys: undefined },
            })
          } catch {
            /* best-effort cleanup */
          }
        }
        return {
          channel: 'webpush',
          recipient: `user:${s.userId}`,
          success: false,
          error: errorMsg,
        }
      }
    })
  )

  return results.filter((r): r is ChannelResult => r !== null)
}

/** Build the Prisma `where` fragment honouring a per-type alert preference. */
function alertTypeWhere(eventType: string): Record<string, boolean> {
  const field = ALERT_PREFERENCE_FIELD[eventType]
  return field ? { [field]: true } : {}
}

// ---------------------------------------------------------------------------
// Public dispatch API
// ---------------------------------------------------------------------------

/**
 * Dispatch a notification across all configured channels. Never throws — all
 * errors are captured per-channel and reflected in the returned summary so the
 * caller (event ingestion) is never broken by a notification failure.
 */
export async function dispatchNotifications(
  payload: NotificationPayload
): Promise<DispatchSummary> {
  const eventType = String(payload.eventType)
  const results: ChannelResult[] = []

  // --- Pushover ---
  try {
    const envCreds = getEnvPushoverCredentials()
    let settingsRows: SettingsRow[] = []
    try {
      settingsRows = (await prisma.notificationSettings.findMany({
        where: { pushoverEnabled: true },
      })) as unknown as SettingsRow[]
    } catch (error) {
      // DB unavailable / model missing (e.g. in unit tests): still honour env.
      console.error(
        `[notifications] could not load pushover settings: ` +
          `${error instanceof Error ? error.message : String(error)}`
      )
    }

    const recipients = resolvePushoverRecipients(settingsRows, envCreds, eventType)
    if (recipients.length === 0 && !envCreds) {
      console.log(
        `[notifications] no Pushover recipients for event=${eventType} ` +
          `(no per-user creds and no PUSHOVER_TOKEN/PUSHOVER_USER env)`
      )
    }
    const pushoverResults = await Promise.all(
      recipients.map((r) => sendPushover(r.credentials, payload, r.recipient))
    )
    results.push(...pushoverResults)
  } catch (error) {
    console.error(
      `[notifications] pushover dispatch error: ` +
        `${error instanceof Error ? error.message : String(error)}`
    )
  }

  // --- Web-push ---
  try {
    const webPushResults = await sendWebPushNotifications(payload, eventType)
    results.push(...webPushResults)
  } catch (error) {
    console.error(
      `[notifications] webpush dispatch error: ` +
        `${error instanceof Error ? error.message : String(error)}`
    )
  }

  const succeeded = results.filter((r) => r.success).length
  const failed = results.length - succeeded
  const summary: DispatchSummary = {
    eventType,
    attempted: results.length,
    succeeded,
    failed,
    results,
  }
  console.log(
    `[notifications] dispatch complete event=${eventType} ` +
      `attempted=${summary.attempted} ok=${succeeded} failed=${failed}`
  )
  return summary
}

export interface DispatchableEvent {
  type: NotificationEventType | string
  device: string
  location?: string
  value?: number
  threshold?: number
  description?: string
}

/** Human-friendly default title per event type. */
const EVENT_TITLES: Record<string, string> = {
  HIGH_CURRENT: 'High Current Alert',
  LOW_PRESSURE: 'Low Pressure Alert',
  LOW_TEMPERATURE: 'Low Temperature Alert',
  SENSOR_ERROR: 'Sensor Error',
  SYSTEM_ERROR: 'System Error',
  MISSING_DATA: 'Missing Data Alert',
  LONG_PUMP_RUN: 'Pump Running Too Long',
  PRESSURE_DROP: 'Possible Leak / Open Fixture',
}

/**
 * Build a payload from an event and dispatch it. Called by the event-ingestion
 * route when a new alert condition is detected. Never throws.
 */
export async function dispatchEventNotifications(
  event: DispatchableEvent
): Promise<DispatchSummary> {
  const type = String(event.type)
  const title = EVENT_TITLES[type] || 'Well Pump Alert'
  const locationLabel = event.location ? ` at ${event.location}` : ''
  const body =
    event.description ||
    `${title}${locationLabel} on ${event.device}` +
      (event.value !== undefined ? ` (value: ${event.value})` : '')

  return dispatchNotifications({
    eventType: type,
    title,
    body,
    data: {
      eventType: type,
      device: event.device,
      location: event.location,
      value: event.value,
      threshold: event.threshold,
    },
  })
}
