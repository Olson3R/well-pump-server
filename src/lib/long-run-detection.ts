/**
 * Server-side detection of a pump that's been "constantly running" too long.
 *
 * The ESP32 already fires HIGH_CURRENT / LOW_PRESSURE / LOW_TEMPERATURE events
 * directly from the device, but it has no awareness of multi-minute runtime
 * accumulation. A pump that runs continuously for an hour is itself a problem
 * — either the well is being over-pumped, a pipe burst is letting the system
 * fill forever, or a fixture (e.g. a stuck toilet) is calling for water non-
 * stop. None of that necessarily trips the per-sample thresholds, so this
 * check runs against the persisted SensorData stream.
 *
 * Detection lives here (called from /api/sensors after the row is saved) so
 * it's evaluated every minute on freshly-arrived data without spinning up a
 * separate cron tick.
 */
import { prisma } from '@/lib/prisma'
import { dispatchEventNotifications } from '@/lib/notifications'

/** Default threshold (minutes) — overridable via SystemSettings. */
export const DEFAULT_LONG_RUN_THRESHOLD_MINUTES = 60

/** Settings key holding the admin-configured threshold (minutes, integer). */
export const LONG_RUN_THRESHOLD_SETTING_KEY = 'longPumpRunThresholdMinutes'

/**
 * Pump-on classifier. A row counts as "on" when any non-zero pump activity is
 * present. Matches DEFAULT_STATS_THRESHOLDS.dutyCycleThreshold so the run
 * boundaries here line up with the canonical stats algorithm.
 */
const ON_DUTY_CYCLE = 0

/**
 * Merge gap (seconds) bridging brief single-sample drops. Same value as
 * DEFAULT_STATS_THRESHOLDS.runMergeGapSeconds — a physical pump cycle that
 * lands across a sampling boundary can momentarily report 0% without actually
 * stopping.
 */
const MERGE_GAP_SECONDS = 120

/**
 * The latest sample must be no older than this for the pump to be considered
 * "currently running". Without a freshness guard, a stale row from hours ago
 * could perpetually claim an active run.
 */
const STALE_LATEST_MS = 5 * 60 * 1000

export interface ActiveLongRun {
  /** Wall-clock start of the contiguous on-run, in epoch ms. */
  runStartMs: number
  /** End of the latest on-sample (used to detect run termination). */
  lastOnEndMs: number
  /** Sum of (dutyCycle1/100) × windowSeconds across the run. */
  actualOnSeconds: number
}

export interface DetectLongRunRow {
  startTime: Date
  endTime: Date
  dutyCycle1: number
}

/**
 * Walk a chronologically-ordered batch of recent sensor rows for one device
 * and return the currently-active long run (if any). Returns null when the
 * pump isn't currently running or when the most recent sample is stale.
 *
 * Pure: no I/O, exported for testing.
 */
export function detectActiveLongRun(
  rows: readonly DetectLongRunRow[],
  now: Date,
): ActiveLongRun | null {
  const mergeGapMs = MERGE_GAP_SECONDS * 1000

  let runStartMs: number | null = null
  let lastOnEndMs: number | null = null
  let actualOnSeconds = 0

  for (const row of rows) {
    const startMs = row.startTime.getTime()
    const endMs = row.endTime.getTime()
    const windowSec = Math.max(0, (endMs - startMs) / 1000)
    const isOn = row.dutyCycle1 > ON_DUTY_CYCLE

    if (isOn) {
      const startsNewRun =
        runStartMs === null ||
        (lastOnEndMs !== null && startMs - lastOnEndMs > mergeGapMs)
      if (startsNewRun) {
        runStartMs = startMs
        actualOnSeconds = 0
      }
      actualOnSeconds += (row.dutyCycle1 / 100) * windowSec
      lastOnEndMs = endMs
    } else if (
      runStartMs !== null &&
      lastOnEndMs !== null &&
      endMs - lastOnEndMs > mergeGapMs
    ) {
      // Long off-stretch — current run has ended.
      runStartMs = null
      lastOnEndMs = null
      actualOnSeconds = 0
    }
  }

  if (runStartMs === null || lastOnEndMs === null) return null
  if (now.getTime() - lastOnEndMs > STALE_LATEST_MS) return null

  return { runStartMs, lastOnEndMs, actualOnSeconds }
}

/**
 * Read the admin-configured threshold from SystemSettings. Falls back to
 * DEFAULT_LONG_RUN_THRESHOLD_MINUTES when unset or invalid. A non-positive
 * stored value disables the check entirely (returns 0).
 */
export async function getLongRunThresholdMinutes(): Promise<number> {
  try {
    const setting = await prisma.systemSettings.findUnique({
      where: { key: LONG_RUN_THRESHOLD_SETTING_KEY },
    })
    if (!setting) return DEFAULT_LONG_RUN_THRESHOLD_MINUTES
    const parsed = parseInt(setting.value, 10)
    if (!Number.isFinite(parsed) || parsed < 0) {
      return DEFAULT_LONG_RUN_THRESHOLD_MINUTES
    }
    return parsed
  } catch (error) {
    console.error(
      '[long-run] failed to read threshold setting; using default:',
      error,
    )
    return DEFAULT_LONG_RUN_THRESHOLD_MINUTES
  }
}

/**
 * Run the long-run check for the given device and reconcile the result against
 * any existing active LONG_PUMP_RUN event:
 *  - Long run detected + no active event  -> create + notify (first detection)
 *  - Long run detected + existing event   -> update value/duration silently
 *  - Long run no longer detected + active -> resolve the event
 *  - Nothing detected + nothing active    -> no-op
 *
 * Never throws — sensor ingestion must not break because of an alerting bug.
 */
export async function checkAndRecordLongRun(
  device: string,
  location: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    const thresholdMinutes = await getLongRunThresholdMinutes()
    // 0 disables the feature entirely. Don't even touch existing events so an
    // admin who turned the feature off doesn't accidentally clear in-flight
    // alerts mid-incident.
    if (thresholdMinutes <= 0) return

    const lookbackMs =
      Math.max(2 * 60, thresholdMinutes + 60) * 60 * 1000
    const since = new Date(now.getTime() - lookbackMs)

    const rows = await prisma.sensorData.findMany({
      where: { device, timestamp: { gte: since } },
      orderBy: { timestamp: 'asc' },
      select: { startTime: true, endTime: true, dutyCycle1: true },
    })

    const active = detectActiveLongRun(rows, now)
    const existingEvent = await prisma.event.findFirst({
      where: { device, type: 'LONG_PUMP_RUN', active: true },
      orderBy: { timestamp: 'desc' },
    })

    const runMinutes = active ? active.actualOnSeconds / 60 : 0
    const thresholdExceeded = active !== null && runMinutes >= thresholdMinutes

    if (thresholdExceeded && active) {
      const runStart = new Date(active.runStartMs)
      const duration = BigInt(now.getTime() - active.runStartMs)
      const description =
        `Pump has been running for ${Math.round(runMinutes)} minutes ` +
        `(threshold: ${thresholdMinutes} min)`

      if (existingEvent) {
        await prisma.event.update({
          where: { id: existingEvent.id },
          data: {
            timestamp: now,
            value: runMinutes,
            duration,
            description,
          },
        })
      } else {
        await prisma.event.create({
          data: {
            device,
            location,
            timestamp: now,
            type: 'LONG_PUMP_RUN',
            value: runMinutes,
            threshold: thresholdMinutes,
            startTime: runStart,
            duration,
            active: true,
            description,
          },
        })
        try {
          await dispatchEventNotifications({
            type: 'LONG_PUMP_RUN',
            device,
            location,
            value: runMinutes,
            threshold: thresholdMinutes,
            description,
          })
        } catch (notifyError) {
          console.error(
            '[long-run] notification dispatch failed:',
            notifyError,
          )
        }
      }
    } else if (existingEvent && !active) {
      // Pump stopped — clear the active alert.
      await prisma.event.update({
        where: { id: existingEvent.id },
        data: { active: false, timestamp: now },
      })
    }
  } catch (error) {
    console.error('[long-run] check failed:', error)
  }
}
