/**
 * Scheduled Pushover summary reports.
 *
 * Each user can opt in (via NotificationSettings) to receive a digest of pump
 * activity over the previous day or week, delivered to their Pushover account
 * at a configurable local hour. An hourly cron job invokes
 * {@link runDueSummaryReports}; per-user opt-in, the chosen hour-in-timezone,
 * and a `summaryReportLastSentAt` idempotency guard keep deliveries to one per
 * window even if the cron fires multiple times.
 *
 * The stats themselves come from the in-memory reference path in {@link
 * computeStatsFromRows}, run against the raw `SensorData` rows in the window.
 * For 24h or 7d windows that's ~1.4k or ~10k rows, comfortable for a single
 * pass without dragging in the SQL window-function query the API uses.
 */
import { prisma } from '@/lib/prisma'
import {
  DEFAULT_STATS_THRESHOLDS,
  StatsThresholds,
  computeStatsFromRows,
  type AggregatedStats,
} from '@/lib/stats'
import {
  getEnvPushoverCredentials,
  sendPushover,
  type ChannelResult,
  type PushoverCredentials,
} from '@/lib/notifications'
import {
  DEFAULT_TEMPERATURE_UNIT,
  formatTemperature,
  toTemperatureUnit,
  type TemperatureUnit,
} from '@/lib/temperature'

export type SummaryReportPeriod = 'day' | 'week'

export interface SummaryReportPayload {
  period: SummaryReportPeriod
  /** Inclusive lower bound (UTC) of the summarised window. */
  start: Date
  /** Inclusive upper bound (UTC) of the summarised window. */
  end: Date
  stats: AggregatedStats
  activeAlerts: number
  /**
   * Coldest / hottest temperature observed across all rows in the window, in
   * Fahrenheit. (The ESP32 stores readings in Fahrenheit despite the README
   * example showing Celsius — values arrive ~60°F at the pump house, not 60°C
   * which would be unsurvivable.) Both `null` when the window contained no
   * data — the body line is then suppressed so we don't show "n/a".
   */
  tempMinF: number | null
  tempMaxF: number | null
  /** Title and body as they'll appear in the Pushover notification. */
  title: string
  body: string
}

export interface SummaryReportSendResult {
  userId: string
  period: SummaryReportPeriod
  delivered: boolean
  /** Set when delivery was skipped (e.g. no Pushover creds for this user). */
  skippedReason?: string
  channel?: ChannelResult
}

const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_DAY = 24 * MS_PER_HOUR
const MIN_DAILY_GAP_MS = 23 * MS_PER_HOUR
const MIN_WEEKLY_GAP_MS = 6 * MS_PER_DAY
/** Weekly reports anchor to Monday in the user's local timezone. */
const WEEKLY_SEND_WEEKDAY = 1

/**
 * Build the per-period window and stats for a summary report. Pure (no I/O
 * besides reading sensor data) so callers can preview a report without sending
 * it — the "send test now" UI uses this directly.
 */
export async function buildSummaryReport(
  period: SummaryReportPeriod,
  now: Date = new Date(),
  options: {
    thresholds?: StatsThresholds
    temperatureUnit?: TemperatureUnit
  } = {},
): Promise<SummaryReportPayload> {
  const thresholds = options.thresholds ?? DEFAULT_STATS_THRESHOLDS
  const temperatureUnit = options.temperatureUnit ?? DEFAULT_TEMPERATURE_UNIT
  const end = now
  const start = new Date(
    end.getTime() - (period === 'week' ? 7 * MS_PER_DAY : MS_PER_DAY),
  )

  const rows = await prisma.sensorData.findMany({
    where: { timestamp: { gte: start, lte: end } },
    select: {
      timestamp: true,
      startTime: true,
      endTime: true,
      dutyCycle1: true,
      pressMin: true,
      tempMin: true,
      tempMax: true,
      device: true,
    },
    orderBy: { timestamp: 'asc' },
  })

  const stats = computeStatsFromRows(rows, thresholds)
  const activeAlerts = await prisma.event.count({ where: { active: true } })
  const { tempMinF, tempMaxF } = aggregateTemperatures(rows)

  const title = period === 'week' ? 'Weekly well-pump summary' : 'Daily well-pump summary'
  const body = formatSummaryBody(period, stats, activeAlerts, tempMinF, tempMaxF, temperatureUnit)

  return { period, start, end, stats, activeAlerts, tempMinF, tempMaxF, title, body }
}

/**
 * Collapse per-row tempMin/tempMax into the coldest and hottest temperature
 * observed across the whole window. Sensor values arrive in Fahrenheit (see
 * lib/temperature.ts), so the aggregate is in Fahrenheit too. Non-finite per-
 * row readings are skipped so a single dropped sensor sample can't poison
 * the aggregate.
 */
function aggregateTemperatures(
  rows: ReadonlyArray<{ tempMin: number; tempMax: number }>,
): { tempMinF: number | null; tempMaxF: number | null } {
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (const row of rows) {
    if (Number.isFinite(row.tempMin) && row.tempMin < lo) lo = row.tempMin
    if (Number.isFinite(row.tempMax) && row.tempMax > hi) hi = row.tempMax
  }
  return {
    tempMinF: Number.isFinite(lo) ? lo : null,
    tempMaxF: Number.isFinite(hi) ? hi : null,
  }
}

/**
 * Look up a user's settings and dispatch a summary report to their Pushover
 * destination. Returns a structured result whether it actually sent or was
 * skipped (e.g. no creds, disabled). Does NOT update `summaryReportLastSentAt`
 * — see {@link runDueSummaryReports} for the scheduler path that bookkeeps.
 *
 * `period` override is for the "send test now" button, which always uses what
 * the user currently has selected. Falls back to the saved period otherwise.
 */
export async function sendSummaryReportFor(
  userId: string,
  options: { period?: SummaryReportPeriod; now?: Date } = {},
): Promise<SummaryReportSendResult> {
  const settings = await prisma.notificationSettings.findUnique({
    where: { userId },
  })
  if (!settings) {
    return { userId, period: options.period ?? 'day', delivered: false, skippedReason: 'no settings' }
  }

  const period: SummaryReportPeriod = options.period ?? toPeriod(settings.summaryReportPeriod)
  const credentials = resolveUserPushoverCreds(settings)
  if (!credentials) {
    return { userId, period, delivered: false, skippedReason: 'no Pushover credentials' }
  }

  const temperatureUnit = toTemperatureUnit(settings.temperatureUnit)
  const report = await buildSummaryReport(period, options.now, { temperatureUnit })
  const result = await sendPushover(
    credentials,
    {
      eventType: period === 'week' ? 'WEEKLY_SUMMARY' : 'DAILY_SUMMARY',
      title: report.title,
      body: report.body,
    },
    `user:${userId}`,
  )

  return { userId, period, delivered: result.success, channel: result }
}

/**
 * Scheduler entrypoint: for every user whose configured local hour matches the
 * current hour (in their own timezone) and who isn't inside their idempotency
 * window, build and send a summary. Returns one result per *processed* user;
 * users whose hour didn't match are silently skipped (not in the return value).
 */
export async function runDueSummaryReports(
  now: Date = new Date(),
): Promise<SummaryReportSendResult[]> {
  const candidates = await prisma.notificationSettings.findMany({
    where: { summaryReportEnabled: true },
  })

  const results: SummaryReportSendResult[] = []
  for (const settings of candidates) {
    const period = toPeriod(settings.summaryReportPeriod)
    const tz = isValidTimezone(settings.summaryReportTimezone)
      ? settings.summaryReportTimezone
      : 'UTC'

    // Time-of-day gate: only fire in the user's configured hour.
    if (hourInTimezone(now, tz) !== settings.summaryReportHourLocal) continue

    // Day-of-week gate for weekly reports.
    if (period === 'week' && weekdayInTimezone(now, tz) !== WEEKLY_SEND_WEEKDAY) continue

    // Idempotency: never send twice in the same window. The thresholds are
    // generous (23h / 6d) to absorb DST shifts and clock drift while still
    // catching genuine duplicates from cron over-fires.
    if (settings.summaryReportLastSentAt) {
      const gap = now.getTime() - settings.summaryReportLastSentAt.getTime()
      const minGap = period === 'week' ? MIN_WEEKLY_GAP_MS : MIN_DAILY_GAP_MS
      if (gap < minGap) continue
    }

    const result = await sendSummaryReportFor(settings.userId, { period, now })
    results.push(result)

    // Only mark as sent when delivery actually succeeded — a failed attempt
    // leaves the timestamp alone so the next tick will retry. Without this a
    // transient Pushover outage at 8am would silently drop the day's report.
    if (result.delivered) {
      await prisma.notificationSettings.update({
        where: { id: settings.id },
        data: { summaryReportLastSentAt: now },
      })
    }
  }

  return results
}

/**
 * Format the report body. Plain text rather than HTML because the default
 * Pushover client renders it more reliably across iOS, Android and desktop.
 */
function formatSummaryBody(
  period: SummaryReportPeriod,
  stats: AggregatedStats,
  activeAlerts: number,
  tempMinF: number | null,
  tempMaxF: number | null,
  temperatureUnit: TemperatureUnit,
): string {
  const range = period === 'week' ? 'Last 7 days' : 'Last 24 hours'
  const avgRunStr =
    stats.pumpRunCount > 0 ? ` (avg ${formatDuration(stats.averagePumpRunSeconds)}/run)` : ''
  const avgLowStr =
    stats.lowPressureEventCount > 0
      ? ` (avg ${formatDuration(stats.averageLowPressureSeconds)}/event)`
      : ''

  const lines = [
    `${range}:`,
    `• Pump runs: ${stats.pumpRunCount}${avgRunStr}`,
    `• Pump runtime: ${formatDuration(stats.pumpDurationSeconds)}`,
    `• Low-pressure events: ${stats.lowPressureEventCount}${avgLowStr}`,
    `• Low-pressure time: ${formatDuration(stats.lowPressureDurationSeconds)}`,
  ]
  // Drop the temperature line entirely when the window had no readings rather
  // than printing a confusing "n/a" alongside real numbers.
  if (tempMinF !== null && tempMaxF !== null) {
    lines.push(
      `• Temperature: ${formatTemperature(tempMinF, temperatureUnit)} – ${formatTemperature(tempMaxF, temperatureUnit)}`,
    )
  }
  lines.push(`• Active alerts: ${activeAlerts}`)
  return lines.join('\n')
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m'
  const totalMinutes = Math.round(seconds / 60)
  const days = Math.floor(totalMinutes / (60 * 24))
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60)
  const minutes = totalMinutes % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`)
  return parts.join(' ')
}

function toPeriod(raw: string): SummaryReportPeriod {
  return raw === 'week' ? 'week' : 'day'
}

/**
 * Return the user's Pushover credentials if they have their own, otherwise the
 * env-level fallback. The env fallback is what makes "I configured one Pushover
 * account in the .env" still work for opt-in users who don't fill in tokens.
 */
function resolveUserPushoverCreds(
  settings: {
    pushoverToken: string | null
    pushoverUser: string | null
  },
): PushoverCredentials | null {
  if (settings.pushoverToken && settings.pushoverUser) {
    return { token: settings.pushoverToken, user: settings.pushoverUser }
  }
  return getEnvPushoverCredentials()
}

/** Hour (0..23) of `date` in the given IANA timezone. */
export function hourInTimezone(date: Date, timeZone: string): number {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false,
  }).format(date)
  // Intl can yield "24" for midnight in some locales — normalise to 0.
  const hour = parseInt(formatted, 10)
  return Number.isFinite(hour) ? hour % 24 : 0
}

/** Day-of-week (0=Sun..6=Sat) of `date` in the given IANA timezone. */
export function weekdayInTimezone(date: Date, timeZone: string): number {
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  }).format(date)
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  }
  return map[wd] ?? 0
}

/**
 * Cheap sanity check that an IANA timezone string is recognised by the JS
 * runtime, used to reject obviously-bad input on save (and so the scheduler
 * can fall back to UTC for any garbage left over from a prior version).
 */
export function isValidTimezone(timeZone: string): boolean {
  if (!timeZone) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}
