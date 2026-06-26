/**
 * Detection of continuously dropping pressure while the pump is off.
 *
 * Water leaving the system when the pump isn't replenishing it means it's
 * going *somewhere* — either through an open fixture (faucet, running toilet,
 * outdoor hose) or a leak. The pressure tank slowly loses charge in either
 * case, and the pattern is distinguishable from normal idle drift only when
 * the drop is large enough and sustained for long enough.
 *
 * Algorithm:
 *   1. From the most recent sensor row, walk back to the most recent
 *      pump-on row. Everything after that is the "pump-off segment".
 *   2. Take the trailing window of `minDurationMinutes` from that segment
 *      (so the alert fires on *currently* dropping pressure, not a drop that
 *      happened then stabilised).
 *   3. Compare the peak pressMin in the window to the latest pressMin.
 *      If the drop is at least `minPsiDrop`, fire.
 *
 * The latest row must also be fresh (within 5 min of `now`) — without that
 * guard a stale row from hours ago could perpetually claim an active leak.
 */
import { prisma } from '@/lib/prisma'
import { dispatchEventNotifications } from '@/lib/notifications'

/** Defaults — pick up roughly half a tank cycle of drift over a quiet stretch. */
export const DEFAULT_PRESSURE_DROP_PSI = 3
export const DEFAULT_PRESSURE_DROP_MINUTES = 10

export const PRESSURE_DROP_PSI_KEY = 'pressureDropThresholdPsi'
export const PRESSURE_DROP_MINUTES_KEY = 'pressureDropDurationMinutes'

/** A row counts as "pump on" when it has any non-zero duty cycle. */
const PUMP_ON_DUTY_CYCLE = 0

/** Required freshness of the most recent row to consider the result actionable. */
const STALE_LATEST_MS = 5 * 60 * 1000

export interface PressureDropThresholds {
  minPsiDrop: number
  minDurationMinutes: number
}

export interface DetectPressureDropRow {
  startTime: Date
  endTime: Date
  dutyCycle1: number
  pressMin: number
}

export interface PressureDropResult {
  /** Highest pressMin seen across the evaluation window. */
  peakPsi: number
  /** pressMin of the most recent row. */
  latestPsi: number
  dropPsi: number
  /** Wall-clock width of the evaluation window in minutes. */
  durationMinutes: number
  /** Start of the evaluation window (epoch ms). */
  startMs: number
}

/**
 * Walk a chronologically-ordered batch of recent rows and decide whether the
 * pump-off segment shows a continuously dropping pressure that meets both
 * thresholds. Pure: no I/O, exported for testing.
 */
export function detectContinuousPressureDrop(
  rows: readonly DetectPressureDropRow[],
  thresholds: PressureDropThresholds,
  now: Date,
): PressureDropResult | null {
  if (rows.length < 2) return null
  if (thresholds.minDurationMinutes <= 0) return null
  if (thresholds.minPsiDrop <= 0) return null

  // Most recent pump-on row delimits the start of the pump-off segment.
  let lastPumpOnIdx = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].dutyCycle1 > PUMP_ON_DUTY_CYCLE) {
      lastPumpOnIdx = i
      break
    }
  }

  const segment = rows.slice(lastPumpOnIdx + 1)
  if (segment.length < 2) return null

  const latest = segment[segment.length - 1]

  // Don't fire on stale data — without this a long-quiet device could appear
  // to have an "active drop" indefinitely.
  if (now.getTime() - latest.endTime.getTime() > STALE_LATEST_MS) return null

  // Trailing window: the last `minDurationMinutes` of the segment. The drop
  // must be present in this window so we alert on *currently* dropping
  // pressure, not on a drop that happened earlier then stabilised.
  const windowMs = thresholds.minDurationMinutes * 60 * 1000
  const windowCutoffMs = latest.endTime.getTime() - windowMs

  // Tolerate a half-bucket slop so we can fire as soon as the window is
  // mostly covered rather than waiting an extra sample.
  const windowRows = segment.filter(
    (r) => r.endTime.getTime() >= windowCutoffMs,
  )
  if (windowRows.length < 2) return null

  const windowFirst = windowRows[0]
  const durationMinutes =
    (latest.endTime.getTime() - windowFirst.startTime.getTime()) / 60000
  if (durationMinutes < thresholds.minDurationMinutes - 0.5) return null

  // Peak within the trailing window — using the segment-wide peak would alert
  // on stabilised post-drop pressure forever.
  let peakPsi = Number.NEGATIVE_INFINITY
  for (const row of windowRows) {
    if (row.pressMin > peakPsi) peakPsi = row.pressMin
  }

  const latestPsi = latest.pressMin
  const dropPsi = peakPsi - latestPsi
  if (dropPsi < thresholds.minPsiDrop) return null

  return {
    peakPsi,
    latestPsi,
    dropPsi,
    durationMinutes,
    startMs: windowFirst.startTime.getTime(),
  }
}

/**
 * Read the configurable thresholds from SystemSettings, falling back to the
 * defaults when missing or malformed.
 */
export async function getPressureDropThresholds(): Promise<PressureDropThresholds> {
  try {
    const rows = await prisma.systemSettings.findMany({
      where: { key: { in: [PRESSURE_DROP_PSI_KEY, PRESSURE_DROP_MINUTES_KEY] } },
    })
    const byKey = new Map(rows.map((r) => [r.key, r.value]))

    const parse = (raw: string | undefined, fallback: number): number => {
      if (raw === undefined) return fallback
      const v = parseFloat(raw)
      if (!Number.isFinite(v) || v < 0) return fallback
      return v
    }

    return {
      minPsiDrop: parse(
        byKey.get(PRESSURE_DROP_PSI_KEY),
        DEFAULT_PRESSURE_DROP_PSI,
      ),
      minDurationMinutes: parse(
        byKey.get(PRESSURE_DROP_MINUTES_KEY),
        DEFAULT_PRESSURE_DROP_MINUTES,
      ),
    }
  } catch (error) {
    console.error('[leak-detection] failed to read thresholds:', error)
    return {
      minPsiDrop: DEFAULT_PRESSURE_DROP_PSI,
      minDurationMinutes: DEFAULT_PRESSURE_DROP_MINUTES,
    }
  }
}

/**
 * Run leak detection for the given device and reconcile the result against
 * any existing active PRESSURE_DROP event:
 *  - Drop detected + no existing -> create + notify
 *  - Drop detected + existing    -> update value/duration silently
 *  - No drop + existing          -> resolve (pump cycled or someone closed the tap)
 * Never throws.
 */
export async function checkAndRecordPressureDrop(
  device: string,
  location: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    const thresholds = await getPressureDropThresholds()
    if (thresholds.minPsiDrop <= 0 || thresholds.minDurationMinutes <= 0) return

    // Look back enough to capture the configured window plus a buffer for
    // whatever pump-off stretch precedes it.
    const lookbackMs =
      Math.max(60, thresholds.minDurationMinutes * 3) * 60 * 1000
    const since = new Date(now.getTime() - lookbackMs)

    const rows = await prisma.sensorData.findMany({
      where: { device, timestamp: { gte: since } },
      orderBy: { timestamp: 'asc' },
      select: {
        startTime: true,
        endTime: true,
        dutyCycle1: true,
        pressMin: true,
      },
    })

    const result = detectContinuousPressureDrop(rows, thresholds, now)
    const existing = await prisma.event.findFirst({
      where: { device, type: 'PRESSURE_DROP', active: true },
      orderBy: { timestamp: 'desc' },
    })

    if (result) {
      const description =
        `Pressure dropped ${result.dropPsi.toFixed(1)} PSI in ` +
        `${Math.round(result.durationMinutes)} min while pump off — ` +
        `possible leak or open fixture`
      const startTime = new Date(result.startMs)

      if (existing) {
        await prisma.event.update({
          where: { id: existing.id },
          data: {
            timestamp: now,
            value: result.dropPsi,
            duration: BigInt(now.getTime() - existing.startTime.getTime()),
            description,
          },
        })
      } else {
        await prisma.event.create({
          data: {
            device,
            location,
            timestamp: now,
            type: 'PRESSURE_DROP',
            value: result.dropPsi,
            threshold: thresholds.minPsiDrop,
            startTime,
            duration: BigInt(now.getTime() - startTime.getTime()),
            active: true,
            description,
          },
        })
        try {
          await dispatchEventNotifications({
            type: 'PRESSURE_DROP',
            device,
            location,
            value: result.dropPsi,
            threshold: thresholds.minPsiDrop,
            description,
          })
        } catch (notifyError) {
          console.error(
            '[leak-detection] notification dispatch failed:',
            notifyError,
          )
        }
      }
    } else if (existing) {
      // Condition cleared (pump cycled / pressure stabilised).
      await prisma.event.update({
        where: { id: existing.id },
        data: { active: false, timestamp: now },
      })
    }
  } catch (error) {
    console.error('[leak-detection] check failed:', error)
  }
}
