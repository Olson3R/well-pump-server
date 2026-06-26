import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getAuthContext, hasPermission } from '@/lib/auth-middleware'
import {
  DEFAULT_STATS_THRESHOLDS,
  buildAggregatedStats,
  type RawStatTotals,
} from '@/lib/stats'

/**
 * GET /api/stats — aggregated operational stats over a time range.
 *
 * Computes, server-side, from raw `SensorData`:
 *   - pumpRunCount               number of pump starts (off→on transitions)
 *   - pumpDurationSeconds/Ms     total time the pump ran
 *   - lowPressureEventCount      number of low-pressure onsets (normal→low edges)
 *   - lowPressureDurationSeconds/Ms total time spent in low pressure
 * plus sampleCount and per-run/per-event averages.
 *
 * Runs and events are derived from STATE TRANSITIONS in the raw rows (see
 * `@/lib/stats`). The whole aggregation runs in a single windowed SQL query so
 * the response stays cheap even for multi-month ranges — only a handful of
 * scalars are ever returned, regardless of how many rows the range spans.
 *
 * Query params (all optional):
 *   startDate, endDate    ISO timestamps bounding the range (inclusive).
 *   device                restrict to a single device.
 *   dutyCycleThreshold    Percentage 0..100; row is pump-ON when `dutyCycle1`
 *                         is strictly greater than this (default 0).
 *   pressureThreshold     PSI; low pressure at/below this (default 30).
 *   runMergeGapSeconds    Two on-stretches separated by an off period ≤ this
 *                         many seconds are merged into one run (default 120).
 */
export async function GET(request: NextRequest) {
  try {
    // Same auth model as /api/sensors: session user or device token with the
    // `sensors` permission may read aggregated sensor stats.
    const authContext = await getAuthContext(request)
    if (!hasPermission(authContext, 'sensors')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const device = searchParams.get('device')
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')

    // --- Parse / validate range ---------------------------------------------
    const start = startDate ? new Date(startDate) : null
    const end = endDate ? new Date(endDate) : null
    if (start && Number.isNaN(start.getTime())) {
      return NextResponse.json({ error: 'Invalid startDate' }, { status: 400 })
    }
    if (end && Number.isNaN(end.getTime())) {
      return NextResponse.json({ error: 'Invalid endDate' }, { status: 400 })
    }
    if (start && end && start.getTime() > end.getTime()) {
      return NextResponse.json(
        { error: 'startDate must be before endDate' },
        { status: 400 }
      )
    }

    // --- Parse / validate thresholds ----------------------------------------
    const dutyCycleThreshold = parseThreshold(
      searchParams.get('dutyCycleThreshold'),
      DEFAULT_STATS_THRESHOLDS.dutyCycleThreshold
    )
    if (dutyCycleThreshold === null) {
      return NextResponse.json(
        { error: 'Invalid dutyCycleThreshold: must be a non-negative number' },
        { status: 400 }
      )
    }
    const pressureThreshold = parseThreshold(
      searchParams.get('pressureThreshold'),
      DEFAULT_STATS_THRESHOLDS.pressureThreshold
    )
    if (pressureThreshold === null) {
      return NextResponse.json(
        { error: 'Invalid pressureThreshold: must be a non-negative number' },
        { status: 400 }
      )
    }
    const runMergeGapSeconds = parseThreshold(
      searchParams.get('runMergeGapSeconds'),
      DEFAULT_STATS_THRESHOLDS.runMergeGapSeconds
    )
    if (runMergeGapSeconds === null) {
      return NextResponse.json(
        { error: 'Invalid runMergeGapSeconds: must be a non-negative number' },
        { status: 400 }
      )
    }

    // --- Build the filtered WHERE clause ------------------------------------
    const whereSql = Prisma.sql`
      WHERE 1 = 1
      ${start ? Prisma.sql`AND timestamp >= ${start}` : Prisma.empty}
      ${end ? Prisma.sql`AND timestamp <= ${end}` : Prisma.empty}
      ${device ? Prisma.sql`AND device = ${device}` : Prisma.empty}
    `

    // --- Single windowed aggregation query ----------------------------------
    // `base`    classifies each row as pump-on (dutyCycle1 > threshold) and
    //           low-pressure, captures the row's duty cycle, start/end times,
    //           and measures its window span (seconds, clamped at 0).
    // `flagged` looks back PER DEVICE to find low-pressure transitions and the
    //           endTime of the most recent prior on-row (used for run-merging).
    // The final SELECT counts pump runs (off→on edges that follow a gap longer
    // than `runMergeGapSeconds`) and sums durations. Pump duration sums
    // `(dutyCycle1 / 100) × window_seconds` so we accrue ACTUAL seconds the
    // pump ran (the /100 converts the percentage to a fraction) rather than
    // full minute windows. Mirrors `computeStatsFromRows` exactly.
    const rawRows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      WITH base AS (
        SELECT
          device,
          timestamp,
          "startTime" AS start_time,
          "endTime" AS end_time,
          "dutyCycle1" AS duty_cycle_1,
          ("dutyCycle1" > ${dutyCycleThreshold}) AS pump_on,
          ("pressMin" <= ${pressureThreshold}) AS low_press,
          GREATEST(EXTRACT(EPOCH FROM ("endTime" - "startTime")), 0) AS window_seconds
        FROM sensor_data
        ${whereSql}
      ),
      flagged AS (
        SELECT
          pump_on,
          low_press,
          duty_cycle_1,
          window_seconds,
          start_time,
          -- End time of the most recent on-row strictly before this row in the
          -- same device's stream. NULL until we've seen any on-row.
          MAX(CASE WHEN pump_on THEN end_time END) OVER (
            PARTITION BY device
            ORDER BY timestamp
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ) AS prev_on_end_time,
          LAG(low_press) OVER (PARTITION BY device ORDER BY timestamp) AS prev_low_press
        FROM base
      )
      SELECT
        COUNT(*) FILTER (
          WHERE pump_on AND (
            prev_on_end_time IS NULL
            OR EXTRACT(EPOCH FROM (start_time - prev_on_end_time)) > ${runMergeGapSeconds}
          )
        ) AS pump_run_count,
        COALESCE(SUM((duty_cycle_1 / 100.0) * window_seconds) FILTER (WHERE pump_on), 0) AS pump_duration_seconds,
        COUNT(*) FILTER (WHERE low_press AND prev_low_press IS DISTINCT FROM TRUE) AS low_pressure_count,
        COALESCE(SUM(window_seconds) FILTER (WHERE low_press), 0) AS low_pressure_duration_seconds,
        COUNT(*) AS sample_count
      FROM flagged
    `)

    const row = rawRows[0] ?? {}
    const totals: RawStatTotals = {
      pumpRunCount: toNumber(row.pump_run_count),
      pumpDurationSeconds: toNumber(row.pump_duration_seconds),
      lowPressureEventCount: toNumber(row.low_pressure_count),
      lowPressureDurationSeconds: toNumber(row.low_pressure_duration_seconds),
      sampleCount: toNumber(row.sample_count),
    }

    return NextResponse.json({
      stats: buildAggregatedStats(totals),
      range: {
        startDate: start ? start.toISOString() : null,
        endDate: end ? end.toISOString() : null,
        device: device ?? null,
      },
      thresholds: { dutyCycleThreshold, pressureThreshold, runMergeGapSeconds },
    })
  } catch (error) {
    console.error('Error computing stats:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * Parse an optional non-negative numeric threshold. Returns the default when the
 * param is absent, the parsed value when valid, or `null` when present-but-invalid
 * (so the caller can return a 400).
 */
function parseThreshold(raw: string | null, fallback: number): number | null {
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return null
  return value
}

/**
 * Coerce a value returned by `$queryRaw` to a finite JS number. Postgres returns
 * COUNT(...) as BigInt and SUM/EXTRACT as number | Prisma.Decimal | string
 * depending on the driver, so normalise all of them here.
 */
function toNumber(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number') return value
  if (value === null || value === undefined) return 0
  const parsed = Number(value as string)
  return Number.isFinite(parsed) ? parsed : 0
}
