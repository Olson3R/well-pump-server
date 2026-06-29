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

/**
 * Plateau check parameters. After confirming the segment-wide drop rate, we
 * bucket the segment into PLATEAU_BUCKET_MINUTES chunks and verify each
 * still shows continued decline. A leak loses pressure continuously; a
 * one-off use leaves a flat tail (and shouldn't alert).
 *
 *  - PLATEAU_BUCKET_MINUTES: 15-min buckets give a stable slope estimate
 *    from ~15 samples while keeping resolution on a 60-min minimum segment.
 *  - PLATEAU_RATE_FRACTION: each bucket must show at least half the
 *    threshold rate. Below that the bucket counts as "flat".
 *  - MAX_CONSECUTIVE_PLATEAU_BUCKETS: tolerate 1 isolated flat bucket
 *    (sensor noise can flatten a 15-min slope estimate even during a real
 *    leak). 2+ in a row means a genuine plateau — fail.
 *  - MIN_BUCKETS_FOR_PLATEAU_CHECK: with fewer than 3 buckets we can't
 *    distinguish a plateau from a short segment, so skip the check.
 */
const PLATEAU_BUCKET_MINUTES = 15
const PLATEAU_RATE_FRACTION = 0.5
const MAX_CONSECUTIVE_PLATEAU_BUCKETS = 1
const MIN_BUCKETS_FOR_PLATEAU_CHECK = 3

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

  // Plateau check: a true leak loses pressure continuously across the segment.
  // A one-off use (or a leak that has stopped) shows a flat tail that the
  // segment-wide slope alone can hide. Bucketing exposes those tails.
  if (
    !passesPlateauCheck(segment, thresholds.maxDropRatePsiPerHour)
  ) {
    return null
  }

  return {
    dropRatePsiPerHour,
    segmentMinutes,
    startPsi: first.pressMin,
    endPsi: last.pressMin,
    segmentStartMs: first.startTime.getTime(),
  }
}

/**
 * True iff every PLATEAU_BUCKET_MINUTES bucket in the segment still shows a
 * meaningful per-bucket drop rate (≥ PLATEAU_RATE_FRACTION × threshold),
 * tolerating at most MAX_CONSECUTIVE_PLATEAU_BUCKETS isolated flat buckets.
 * Buckets with too few samples to fit a slope are skipped (they don't count
 * as plateau OR as drop).
 *
 * Skipped entirely when the segment yields fewer than
 * MIN_BUCKETS_FOR_PLATEAU_CHECK buckets — short segments lean on the rate
 * check alone.
 */
function passesPlateauCheck(
  segment: readonly DetectPressureDropRow[],
  thresholdRatePsiPerHour: number,
): boolean {
  const bucketWidthMs = PLATEAU_BUCKET_MINUTES * 60 * 1000
  const buckets = bucketByTime(segment, bucketWidthMs)
  if (buckets.length < MIN_BUCKETS_FOR_PLATEAU_CHECK) return true

  const minBucketRate = thresholdRatePsiPerHour * PLATEAU_RATE_FRACTION
  let consecutivePlateaus = 0
  for (const bucket of buckets) {
    if (bucket.length < 2) continue // not enough to fit; neither pass nor fail
    const bucketSlope = slope(
      bucket.map((r) => ({ x: r.startTime.getTime(), y: r.pressMin })),
    )
    const bucketRate = -bucketSlope * 3_600_000
    if (bucketRate < minBucketRate) {
      consecutivePlateaus += 1
      if (consecutivePlateaus > MAX_CONSECUTIVE_PLATEAU_BUCKETS) return false
    } else {
      consecutivePlateaus = 0
    }
  }
  return true
}

/**
 * Group consecutive rows into fixed-width time buckets starting at the first
 * row's startTime. Rows that fall entirely past the last bucket boundary
 * close out the current bucket and open the next; rows are never split
 * across buckets.
 */
function bucketByTime(
  rows: readonly DetectPressureDropRow[],
  bucketMs: number,
): DetectPressureDropRow[][] {
  if (rows.length === 0) return []
  const buckets: DetectPressureDropRow[][] = []
  let current: DetectPressureDropRow[] = []
  let nextBoundaryMs = rows[0].startTime.getTime() + bucketMs
  for (const row of rows) {
    while (row.startTime.getTime() >= nextBoundaryMs) {
      if (current.length > 0) buckets.push(current)
      current = []
      nextBoundaryMs += bucketMs
    }
    current.push(row)
  }
  if (current.length > 0) buckets.push(current)
  return buckets
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
