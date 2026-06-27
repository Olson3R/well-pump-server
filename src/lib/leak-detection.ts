/**
 * Leak detection via pressure drop *rate* during a pump-off segment.
 *
 * The earlier "always-dropping over 3 hours" check couldn't fire on real-world
 * leaks because a leak fast enough to matter often cycles the pump every
 * 2–3 hours. There's never a 3-hour pump-off window — the pump keeps topping
 * up. But within each pump-off segment, the slope itself is the signal:
 *
 *   - tight residential well system, idle: pressure drift ≪ 0.5 PSI/h
 *     (thermal + sensor noise)
 *   - leak / running fixture: 3–20 PSI/h, depending on rate
 *
 * The 60-min minimum segment length is just enough samples to compute a stable
 * linear-regression slope without overweighting one noisy reading; the rate
 * threshold (PSI/h) is what actually distinguishes a leak from quiet drift.
 *
 * Algorithm:
 *   1. Walk back from the latest sensor row to the most recent pump-on row.
 *      The "current pump-off segment" is everything after that.
 *   2. Require the segment to be ≥ minSegmentMinutes long and end in a
 *      fresh row (< 5 min stale).
 *   3. Run a least-squares linear regression of pressMin on time across the
 *      segment, in PSI per hour. Linear regression is robust to per-sample
 *      noise and to small mid-segment dips from one-off usage events that
 *      don't trigger pump cycling.
 *   4. If the resulting drop rate (= −slope) exceeds the configured PSI/h
 *      threshold, fire.
 *
 * This generalises the previous detector: a slow leak that *would* have shown
 * up as "always dropping over 3h" trivially fits — its drop rate over the
 * 3h pump-off segment is well above the rate threshold. But it also catches
 * the fast leaks that cycle the pump within a couple hours, which the prior
 * window-based check missed entirely.
 */
import { prisma } from '@/lib/prisma'
import { dispatchEventNotifications } from '@/lib/notifications'

/**
 * Defaults. 2 PSI/h is well above the noise floor of a tight residential
 * system (which drifts at most ~0.5 PSI/h from temperature + sensor noise)
 * and well below the rate of any leak worth alerting on. 60-min minimum
 * segment length gives ~60 samples for a stable slope estimate.
 */
export const DEFAULT_PRESSURE_DROP_RATE_PSI_PER_HOUR = 2
export const DEFAULT_PRESSURE_DROP_SEGMENT_MINUTES = 60

export const PRESSURE_DROP_RATE_KEY = 'pressureDropMaxPsiPerHour'
export const PRESSURE_DROP_SEGMENT_KEY = 'pressureDropMinSegmentMinutes'

/** A row counts as "pump on" when it has any non-zero duty cycle. */
const PUMP_ON_DUTY_CYCLE = 0

/** Required freshness of the most recent row to consider the result actionable. */
const STALE_LATEST_MS = 5 * 60 * 1000

export interface PressureDropThresholds {
  /** Drop rate (PSI per hour) at or above which to fire. */
  maxDropRatePsiPerHour: number
  /** Minimum pump-off segment length to evaluate (minutes). */
  minSegmentMinutes: number
}

export interface DetectPressureDropRow {
  startTime: Date
  endTime: Date
  dutyCycle1: number
  pressMin: number
}

export interface PressureDropResult {
  /** Drop rate over the segment, PSI/h. Positive when pressure is dropping. */
  dropRatePsiPerHour: number
  /** Length of the segment evaluated (minutes). */
  segmentMinutes: number
  /** pressMin of the segment's first row. */
  startPsi: number
  /** pressMin of the segment's last row. */
  endPsi: number
  /** Segment start (epoch ms). */
  segmentStartMs: number
}

/**
 * Centred least-squares slope. Centring on the mean of x avoids the float
 * precision pitfalls of running the textbook formula on epoch-ms x-values.
 * Returns 0 when there isn't enough variance to fit a line.
 */
function slope(points: ReadonlyArray<{ x: number; y: number }>): number {
  const n = points.length
  if (n < 2) return 0
  let meanX = 0
  let meanY = 0
  for (const p of points) {
    meanX += p.x
    meanY += p.y
  }
  meanX /= n
  meanY /= n
  let num = 0
  let den = 0
  for (const p of points) {
    const dx = p.x - meanX
    num += dx * (p.y - meanY)
    den += dx * dx
  }
  if (den === 0) return 0
  return num / den
}

/**
 * Decide whether the current pump-off segment shows a drop rate above the
 * configured threshold. Pure: no I/O, exported for testing.
 */
export function detectContinuousPressureDrop(
  rows: readonly DetectPressureDropRow[],
  thresholds: PressureDropThresholds,
  now: Date,
): PressureDropResult | null {
  if (rows.length < 2) return null
  if (thresholds.maxDropRatePsiPerHour <= 0) return null
  if (thresholds.minSegmentMinutes <= 0) return null

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

  const first = segment[0]
  const last = segment[segment.length - 1]

  // Don't fire on stale data — a long-quiet device could otherwise appear to
  // have an "active drop" indefinitely after the leak stopped.
  if (now.getTime() - last.endTime.getTime() > STALE_LATEST_MS) return null

  // Need enough segment time for a stable slope.
  const segmentMs = last.endTime.getTime() - first.startTime.getTime()
  const segmentMinutes = segmentMs / 60000
  if (segmentMinutes < thresholds.minSegmentMinutes) return null

  const points = segment.map((r) => ({
    x: r.startTime.getTime(),
    y: r.pressMin,
  }))
  const slopePsiPerMs = slope(points)
  // Slope is negative when pressure is dropping; flip to a positive rate.
  const dropRatePsiPerHour = -slopePsiPerMs * 3_600_000

  if (dropRatePsiPerHour < thresholds.maxDropRatePsiPerHour) return null

  return {
    dropRatePsiPerHour,
    segmentMinutes,
    startPsi: first.pressMin,
    endPsi: last.pressMin,
    segmentStartMs: first.startTime.getTime(),
  }
}

/**
 * Read the configurable thresholds from SystemSettings, falling back to the
 * defaults when missing or malformed.
 */
export async function getPressureDropThresholds(): Promise<PressureDropThresholds> {
  try {
    const rows = await prisma.systemSettings.findMany({
      where: { key: { in: [PRESSURE_DROP_RATE_KEY, PRESSURE_DROP_SEGMENT_KEY] } },
    })
    const byKey = new Map(rows.map((r) => [r.key, r.value]))

    const parse = (raw: string | undefined, fallback: number): number => {
      if (raw === undefined) return fallback
      const v = parseFloat(raw)
      if (!Number.isFinite(v) || v < 0) return fallback
      return v
    }

    return {
      maxDropRatePsiPerHour: parse(
        byKey.get(PRESSURE_DROP_RATE_KEY),
        DEFAULT_PRESSURE_DROP_RATE_PSI_PER_HOUR,
      ),
      minSegmentMinutes: parse(
        byKey.get(PRESSURE_DROP_SEGMENT_KEY),
        DEFAULT_PRESSURE_DROP_SEGMENT_MINUTES,
      ),
    }
  } catch (error) {
    console.error('[leak-detection] failed to read thresholds:', error)
    return {
      maxDropRatePsiPerHour: DEFAULT_PRESSURE_DROP_RATE_PSI_PER_HOUR,
      minSegmentMinutes: DEFAULT_PRESSURE_DROP_SEGMENT_MINUTES,
    }
  }
}

/**
 * Run leak detection for the given device and reconcile against any existing
 * active PRESSURE_DROP event:
 *  - Drop detected + no existing -> create + notify
 *  - Drop detected + existing    -> update value/duration silently
 *  - No drop + existing          -> resolve (pump cycled / rate fell back)
 * Never throws.
 */
export async function checkAndRecordPressureDrop(
  device: string,
  location: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    const thresholds = await getPressureDropThresholds()
    if (
      thresholds.maxDropRatePsiPerHour <= 0 ||
      thresholds.minSegmentMinutes <= 0
    ) {
      return
    }

    // Pull enough recent data to cover a long pump-off segment. Anything that
    // hasn't seen a pump cycle in 12 hours can still be assessed.
    const lookbackMs =
      Math.max(120, thresholds.minSegmentMinutes * 4) * 60 * 1000
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
        `Pressure dropping at ${result.dropRatePsiPerHour.toFixed(1)} PSI/h ` +
        `(${result.startPsi.toFixed(1)} → ${result.endPsi.toFixed(1)} over ` +
        `${Math.round(result.segmentMinutes)} min) while pump off — ` +
        `possible leak or open fixture`
      const startTime = new Date(result.segmentStartMs)

      if (existing) {
        await prisma.event.update({
          where: { id: existing.id },
          data: {
            timestamp: now,
            value: result.dropRatePsiPerHour,
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
            value: result.dropRatePsiPerHour,
            threshold: thresholds.maxDropRatePsiPerHour,
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
            value: result.dropRatePsiPerHour,
            threshold: thresholds.maxDropRatePsiPerHour,
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
      // Condition cleared (pump cycled / rate fell back below threshold).
      await prisma.event.update({
        where: { id: existing.id },
        data: { active: false, timestamp: now },
      })
    }
  } catch (error) {
    console.error('[leak-detection] check failed:', error)
  }
}
