/**
 * Detection of pressure always-dropping during a sustained pump-off window.
 *
 * Water leaving the system when the pump isn't replenishing it means it's
 * going *somewhere* — either through an open fixture (running toilet, outdoor
 * hose, dripping faucet) or a real leak. The signature we're after is: across
 * a long pump-off window, pressure trends consistently downward at a rate
 * exceeding normal idle drift, rather than dropping in one discrete step from
 * a one-off use.
 *
 * Algorithm (quarter-bucket monotonicity over the whole window):
 *   1. Take all sensor rows within the last `windowMinutes`.
 *   2. Require pump-off (dutyCycle1 == 0) for every row in the window — a
 *      single pump cycle aborts the evaluation. Mid-window cycling is normal
 *      under heavy use and not what this detector is for.
 *   3. Require the latest row to be fresh (< 5 min stale) and the window to
 *      be ≥90% covered by data.
 *   4. Split the window into 4 quarter-buckets by time and average pressMin
 *      within each. Bucketing smooths per-sample sensor jitter.
 *   5. Reject if any bucket is significantly higher than the previous one —
 *      pressure recovered, so it isn't actually "always dropping".
 *   6. Require at least 2 of 3 bucket transitions to show a meaningful drop
 *      (≥ small tolerance). This forces the decline to be DISTRIBUTED across
 *      the window, which is what distinguishes a leak from a one-off use
 *      (bathtub fill, etc.) that produces a single step then a flat tail.
 *   7. Require the cumulative drop (first bucket avg − last bucket avg) to
 *      meet the configured `minPsiDrop`.
 *
 * Why bucketed + monotonicity beats raw-window drop:
 *   - A bathtub at minute 60 of a 180-minute window would pass a naive
 *     "first vs last" comparison; the step+flat profile only fails the
 *     "at least 2 of 3 transitions drop" requirement.
 *   - Sensor jitter on the order of 0.1–0.2 PSI doesn't trip the per-bucket
 *     check because the bucket itself averages many samples.
 *   - A leak slow enough to dodge the pump (the only kind worth alerting on
 *     here, since faster leaks present as pump cycling) accrues consistently
 *     bucket over bucket, even at 0.5–1 PSI per hour.
 */
import { prisma } from '@/lib/prisma'
import { dispatchEventNotifications } from '@/lib/notifications'

/**
 * Defaults — a 3-hour window catches the slow-leak / dripping-fixture cases
 * that don't trip pump cycling; a 2-PSI minimum drop comfortably exceeds
 * thermal drift across that window for a typical pump house.
 */
export const DEFAULT_PRESSURE_DROP_PSI = 2
export const DEFAULT_PRESSURE_DROP_MINUTES = 180

export const PRESSURE_DROP_PSI_KEY = 'pressureDropThresholdPsi'
export const PRESSURE_DROP_MINUTES_KEY = 'pressureDropDurationMinutes'

/** A row counts as "pump on" when it has any non-zero duty cycle. */
const PUMP_ON_DUTY_CYCLE = 0

/** Required freshness of the most recent row to consider the result actionable. */
const STALE_LATEST_MS = 5 * 60 * 1000

/** Window must be at least this fraction covered by data (no big gaps at the start). */
const MIN_WINDOW_COVERAGE = 0.9

/**
 * Split the window into this many equal-time buckets for trend analysis.
 * 6 buckets over a 3-hour window = 30-min buckets, which keeps a single
 * discrete-use event localized to one bucket (and therefore one or two
 * transitions) rather than smearing across multiple buckets.
 */
const BUCKET_COUNT = 6

/**
 * A bucket-to-bucket transition counts as a "meaningful drop" when the next
 * bucket's average is at least this many PSI lower. Set just above sensor
 * jitter so noise doesn't masquerade as a drop.
 */
const BUCKET_DROP_TOLERANCE_PSI = 0.2

/**
 * Any bucket more than this many PSI higher than the previous bucket aborts
 * the evaluation — pressure recovered partway through the window, which is
 * incompatible with "always dropping". Tuned to allow modest thermal drift
 * (a sunny afternoon can warm a pump house by a couple of PSI) while still
 * catching real recovery.
 */
const BUCKET_RISE_REJECT_PSI = 1.0

/**
 * Minimum number of bucket-to-bucket transitions that must show a meaningful
 * drop. With 6 buckets there are 5 transitions; requiring 4 of 5 forces the
 * decline to be DISTRIBUTED across the window. A bathtub-style single step
 * only affects one or two transitions, so it can't clear this bar — only a
 * leak that bleeds pressure continuously can.
 */
const REQUIRED_DROPPING_TRANSITIONS = BUCKET_COUNT - 2

export interface PressureDropThresholds {
  /** Minimum total drop across the bucket averages (PSI). */
  minPsiDrop: number
  /** Length of the evaluation window (minutes). */
  minDurationMinutes: number
}

export interface DetectPressureDropRow {
  startTime: Date
  endTime: Date
  dutyCycle1: number
  pressMin: number
}

export interface PressureDropResult {
  /** Average pressMin of the first quarter-bucket. */
  startPsi: number
  /** Average pressMin of the last quarter-bucket. */
  endPsi: number
  /** startPsi − endPsi (PSI). */
  dropPsi: number
  /** Wall-clock width of the evaluated window in minutes. */
  durationMinutes: number
  /** Per-bucket averages, oldest → newest (diagnostic). */
  bucketAverages: number[]
  /** Start of the evaluation window (epoch ms). */
  startMs: number
}

/**
 * Walk a chronologically-ordered batch of recent rows for one device and
 * decide whether the configured window shows pressure consistently dropping.
 * Pure: no I/O, exported for testing.
 */
export function detectContinuousPressureDrop(
  rows: readonly DetectPressureDropRow[],
  thresholds: PressureDropThresholds,
  now: Date,
): PressureDropResult | null {
  if (thresholds.minPsiDrop <= 0) return null
  if (thresholds.minDurationMinutes <= 0) return null
  if (rows.length < BUCKET_COUNT) return null

  const windowMs = thresholds.minDurationMinutes * 60 * 1000
  const windowStartMs = now.getTime() - windowMs

  // Rows whose sampling window intersects the evaluation window.
  const windowRows = rows.filter(
    (r) => r.endTime.getTime() >= windowStartMs,
  )
  if (windowRows.length < BUCKET_COUNT) return null

  // Pump-off requirement — any cycle disqualifies the window.
  for (const row of windowRows) {
    if (row.dutyCycle1 > PUMP_ON_DUTY_CYCLE) return null
  }

  const latest = windowRows[windowRows.length - 1]
  // Don't fire on stale data — a long-quiet device could otherwise appear to
  // have an "always dropping" window indefinitely.
  if (now.getTime() - latest.endTime.getTime() > STALE_LATEST_MS) return null

  // Window coverage — need data spanning most of the window (the first row's
  // startTime can be a little later than windowStartMs without invalidating
  // a 3-hour evaluation).
  const firstRow = windowRows[0]
  const coverageMs = latest.endTime.getTime() - firstRow.startTime.getTime()
  if (coverageMs < windowMs * MIN_WINDOW_COVERAGE) return null

  // Bucket by the midpoint of each row's sampling window so a row that
  // straddles a boundary lands in exactly one bucket.
  const bucketWidthMs = windowMs / BUCKET_COUNT
  const buckets: number[][] = Array.from({ length: BUCKET_COUNT }, () => [])
  for (const row of windowRows) {
    const midMs = (row.startTime.getTime() + row.endTime.getTime()) / 2
    const offset = midMs - windowStartMs
    if (offset < 0) continue // row starts before our window; skip.
    const idx = Math.min(
      BUCKET_COUNT - 1,
      Math.max(0, Math.floor(offset / bucketWidthMs)),
    )
    buckets[idx].push(row.pressMin)
  }

  // Every bucket needs data — otherwise we can't speak to that quarter of
  // the window and can't claim "always" anything.
  if (buckets.some((b) => b.length === 0)) return null

  const avgs = buckets.map(
    (b) => b.reduce((s, v) => s + v, 0) / b.length,
  )

  // Reject if any bucket recovers significantly above its predecessor.
  for (let i = 1; i < avgs.length; i++) {
    if (avgs[i] > avgs[i - 1] + BUCKET_RISE_REJECT_PSI) return null
  }

  // Count transitions that show a meaningful drop. Forcing this counts ≥ N−2
  // distributes the decline across the window — a bathtub-style single step
  // followed by flat values would only have one dropping transition.
  let droppingTransitions = 0
  for (let i = 1; i < avgs.length; i++) {
    if (avgs[i] <= avgs[i - 1] - BUCKET_DROP_TOLERANCE_PSI) {
      droppingTransitions += 1
    }
  }
  if (droppingTransitions < REQUIRED_DROPPING_TRANSITIONS) return null

  const startPsi = avgs[0]
  const endPsi = avgs[avgs.length - 1]
  const dropPsi = startPsi - endPsi
  if (dropPsi < thresholds.minPsiDrop) return null

  return {
    startPsi,
    endPsi,
    dropPsi,
    durationMinutes: coverageMs / 60000,
    bucketAverages: avgs,
    startMs: firstRow.startTime.getTime(),
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
 *  - No drop + existing          -> resolve (pump cycled or pressure recovered)
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

    // Look back enough to capture the configured window plus a small buffer.
    const lookbackMs =
      Math.max(60, thresholds.minDurationMinutes + 15) * 60 * 1000
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
        `Pressure trending down ${result.dropPsi.toFixed(1)} PSI over ` +
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
      // Condition cleared (pump cycled / pressure recovered / no longer dropping).
      await prisma.event.update({
        where: { id: existing.id },
        data: { active: false, timestamp: now },
      })
    }
  } catch (error) {
    console.error('[leak-detection] check failed:', error)
  }
}
