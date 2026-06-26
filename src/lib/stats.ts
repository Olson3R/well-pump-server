/**
 * Stats aggregation helpers.
 *
 * The well-pump monitor stores raw `SensorData` rows (~1 row/minute), each row
 * being a summary over a short sampling window (`startTime` → `endTime`) with a
 * representative RMS current and a minimum pressure. From this raw data we derive
 * higher-level operational stats over an arbitrary time range:
 *
 *   - pump run count          (how many times the pump started)
 *   - total pump duration     (how long the pump ran in total)
 *   - low-pressure event count(how many times pressure dipped into the low band)
 *   - total low-pressure time (how long the system spent in low pressure)
 *
 * Runs and low-pressure events are derived from STATE TRANSITIONS: each row is
 * classified as pump-on/off and low/normal pressure; a new run (or event) is
 * counted on every off→on (or normal→low) edge, and total durations are the sum
 * of the window spans of the rows in that state.
 *
 * The production endpoint (`/api/stats`) performs this aggregation server-side in
 * a single SQL query (window functions) so it stays cheap for long ranges. This
 * module is the canonical reference implementation of the same algorithm: it is
 * exhaustively unit-tested against representative datasets, and the SQL in the
 * route is kept in lock-step with it. {@link buildAggregatedStats} is shared by
 * both paths so the response shape is computed in exactly one place.
 */

export interface StatsThresholds {
  /** Pump is considered ON when `current1RMS` is at or above this many Amps. */
  currentThreshold: number
  /** System is considered LOW PRESSURE when `pressMin` is at or below this PSI. */
  pressureThreshold: number
}

/**
 * Sensible defaults for a typical residential well-pump system.
 *
 *  - currentThreshold 0.5 A: clearly separates a running pump (several Amps RMS)
 *    from idle leakage / sensor noise (≈0.1 A).
 *  - pressureThreshold 30 PSI: a standard cut-in pressure; dipping to/below it
 *    indicates the system is struggling to keep up (a low-pressure condition).
 *
 * Both can be overridden per-request via query parameters.
 */
export const DEFAULT_STATS_THRESHOLDS: StatsThresholds = {
  currentThreshold: 0.5,
  pressureThreshold: 30,
}

/** Minimal shape of a raw sensor row required to derive stats. */
export interface StatsRow {
  /** Used only for chronological ordering of transitions. */
  timestamp?: Date | string | number
  /** Start of the sampling window. */
  startTime: Date | string | number
  /** End of the sampling window. */
  endTime: Date | string | number
  /** Representative RMS current for the pump circuit (Amps). */
  current1RMS: number
  /** Minimum pressure observed in the window (PSI). */
  pressMin: number
  /**
   * Optional device id. When present, transitions are detected PER DEVICE so a
   * mix of devices in one dataset does not produce phantom edges.
   */
  device?: string
}

/** The four headline totals before derived/secondary fields are computed. */
export interface RawStatTotals {
  pumpRunCount: number
  pumpDurationSeconds: number
  lowPressureEventCount: number
  lowPressureDurationSeconds: number
  /** Number of raw rows considered (useful for sanity-checking coverage). */
  sampleCount: number
}

/** Full stats payload returned by the endpoint. */
export interface AggregatedStats extends RawStatTotals {
  pumpDurationMs: number
  lowPressureDurationMs: number
  /** Mean run length in seconds (0 when there were no runs). */
  averagePumpRunSeconds: number
  /** Mean low-pressure spell length in seconds (0 when there were none). */
  averageLowPressureSeconds: number
}

const MS_PER_SECOND = 1000

function toMillis(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  return new Date(value).getTime()
}

/** Duration of a row's sampling window in seconds; never negative. */
function windowSeconds(row: StatsRow): number {
  const span = toMillis(row.endTime) - toMillis(row.startTime)
  return span > 0 ? span / MS_PER_SECOND : 0
}

function round(value: number, decimals = 3): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/**
 * Compute the full {@link AggregatedStats} payload from the four raw totals,
 * adding millisecond conveniences and per-run/per-event averages. Shared by the
 * SQL path (endpoint) and the row-based reference path so the derived fields are
 * defined in exactly one place.
 */
export function buildAggregatedStats(totals: RawStatTotals): AggregatedStats {
  const {
    pumpRunCount,
    pumpDurationSeconds,
    lowPressureEventCount,
    lowPressureDurationSeconds,
    sampleCount,
  } = totals

  return {
    pumpRunCount,
    pumpDurationSeconds: round(pumpDurationSeconds),
    pumpDurationMs: Math.round(pumpDurationSeconds * MS_PER_SECOND),
    lowPressureEventCount,
    lowPressureDurationSeconds: round(lowPressureDurationSeconds),
    lowPressureDurationMs: Math.round(lowPressureDurationSeconds * MS_PER_SECOND),
    sampleCount,
    averagePumpRunSeconds:
      pumpRunCount > 0 ? round(pumpDurationSeconds / pumpRunCount) : 0,
    averageLowPressureSeconds:
      lowPressureEventCount > 0
        ? round(lowPressureDurationSeconds / lowPressureEventCount)
        : 0,
  }
}

/** Chronological sort key for a row (prefers `timestamp`, falls back to `startTime`). */
function orderKey(row: StatsRow): number {
  return toMillis(row.timestamp ?? row.startTime)
}

/**
 * Reference implementation of the stats derivation, operating on in-memory rows.
 *
 * Rows are grouped by device, ordered chronologically, and walked once. A row is
 * "pump on" when `current1RMS >= currentThreshold` and "low pressure" when
 * `pressMin <= pressureThreshold`. Each off→on edge increments the run count and
 * each normal→low edge increments the low-pressure event count; total durations
 * accumulate the window span of every row found in the respective state.
 *
 * This mirrors the SQL executed by `/api/stats` exactly. It is used directly by
 * the test-suite and is safe to call from server code as a fallback.
 */
export function computeStatsFromRows(
  rows: readonly StatsRow[],
  thresholds: StatsThresholds = DEFAULT_STATS_THRESHOLDS,
): AggregatedStats {
  const { currentThreshold, pressureThreshold } = thresholds

  const totals: RawStatTotals = {
    pumpRunCount: 0,
    pumpDurationSeconds: 0,
    lowPressureEventCount: 0,
    lowPressureDurationSeconds: 0,
    sampleCount: rows.length,
  }

  // Group by device so transitions are detected independently per device.
  const groups = new Map<string, StatsRow[]>()
  for (const row of rows) {
    const key = row.device ?? '__default__'
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }

  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => orderKey(a) - orderKey(b))

    let prevPumpOn = false
    let prevLowPress = false

    for (const row of ordered) {
      const pumpOn = row.current1RMS >= currentThreshold
      const lowPress = row.pressMin <= pressureThreshold
      const seconds = windowSeconds(row)

      if (pumpOn) {
        if (!prevPumpOn) totals.pumpRunCount += 1
        totals.pumpDurationSeconds += seconds
      }

      if (lowPress) {
        if (!prevLowPress) totals.lowPressureEventCount += 1
        totals.lowPressureDurationSeconds += seconds
      }

      prevPumpOn = pumpOn
      prevLowPress = lowPress
    }
  }

  return buildAggregatedStats(totals)
}
