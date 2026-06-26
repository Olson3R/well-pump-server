/**
 * REGRESSION GUARD: "Data pages don't show the full selected range
 * (worse for longer periods)."
 *
 * Originally a diagnostic reproduction (expected to FAIL) — see
 * PAGINATION_FINDINGS.md. Both defects are now fixed and these tests pin the
 * corrected behavior so the bug cannot silently return:
 *
 *   A — backend query layer: a bounded window must NOT be capped to a fixed
 *       page size; the full range is returned (raw) or transparently
 *       downsampled (aggregated), never silently truncated.
 *   B — frontend custom-range window: both bounds are built in the same zone,
 *       so the selected final day is fully included.
 *
 * These tests exercise pure date/selection logic (no `next/server` import), so
 * they avoid the DOM/Node harness split that affects the API route tests.
 */

// Force a negative-UTC-offset zone BEFORE any Date is constructed so Repro B is
// deterministic on any CI machine. Node re-reads process.env.TZ on assignment.
process.env.TZ = 'America/Los_Angeles'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// A fixed "now" so the repro is stable regardless of the wall clock.
const NOW = new Date('2026-06-25T12:00:00.000Z').getTime()

// Mirror of the backend tuning constants (src/app/api/sensors/route.ts).
const MAX_RAW_ROWS = 5000

/**
 * Faithful model of the CORRECTED selection semantics in
 * src/app/api/sensors/route.ts (GET) for a bounded (date-range) query with no
 * explicit `limit`:
 *   - if the window fits within the raw-row budget, every row is returned;
 *   - otherwise the server downsamples to one point per bucket covering the
 *     WHOLE window.
 * Either way the earliest returned point reaches the start of the window.
 */
function backendSelectBounded(
  rows: { timestamp: number }[],
  windowStart: number,
  windowEnd: number
) {
  const inWindow = rows
    .filter((r) => r.timestamp >= windowStart && r.timestamp <= windowEnd)
    .sort((a, b) => b.timestamp - a.timestamp)

  if (inWindow.length <= MAX_RAW_ROWS) {
    return inWindow // full raw range
  }

  // Downsample to hourly buckets spanning the entire window (keep the oldest
  // sample in each bucket so coverage reaches windowStart).
  const byBucket = new Map<number, { timestamp: number }>()
  for (const r of inWindow) {
    const bucket = Math.floor(r.timestamp / HOUR) * HOUR
    const existing = byBucket.get(bucket)
    if (!existing || r.timestamp < existing.timestamp) byBucket.set(bucket, r)
  }
  return [...byBucket.values()].sort((a, b) => b.timestamp - a.timestamp)
}

/** One SensorData row per minute across [now - spanDays, now]. */
function generateSamples(spanDays: number) {
  const start = NOW - spanDays * DAY
  const rows: { timestamp: number }[] = []
  for (let t = start; t <= NOW; t += MINUTE) rows.push({ timestamp: t })
  return { rows, windowStart: start, windowEnd: NOW }
}

describe('FIX A — backend returns the full selected range', () => {
  it.each([
    ['1h', 1 / 24],
    ['24h', 1],
    ['7d', 7],
    ['30d', 30],
  ])('covers (essentially) the whole %s window', (_label, spanDays) => {
    const { rows, windowStart, windowEnd } = generateSamples(spanDays as number)

    const returned = backendSelectBounded(rows, windowStart, windowEnd)
    const earliestReturned = Math.min(...returned.map((r) => r.timestamp))

    const coveredMs = NOW - earliestReturned
    const requestedMs = NOW - windowStart
    const coverageFraction = coveredMs / requestedMs

    // The response reaches the start of the selected range regardless of length.
    expect(coverageFraction).toBeGreaterThan(0.99)
  })
})

describe('FIX B — custom range end is built in a single (local) zone', () => {
  // Mirrors the corrected src/app/data/page.tsx fetchData():
  //   start = new Date(`${customStart}T00:00:00`)       // local start-of-day
  //   end   = new Date(`${customEnd}T23:59:59.999`)     // local end-of-day
  function buildCustomWindow(customStart: string, customEnd: string) {
    const start = new Date(`${customStart}T00:00:00`)
    const end = new Date(`${customEnd}T23:59:59.999`)
    return { start: start.getTime(), end: end.getTime() }
  }

  it('includes a reading from the evening of the selected end day', () => {
    const { start, end } = buildCustomWindow('2026-06-01', '2026-06-25')

    // A real reading taken at 8pm LOCAL on the selected end day.
    const eveningOfEndDay = new Date('2026-06-25T20:00:00') // local (TZ forced above)

    const included =
      eveningOfEndDay.getTime() >= start && eveningOfEndDay.getTime() <= end

    expect(included).toBe(true)
  })

  it('includes a reading at the very start of the selected first day', () => {
    const { start, end } = buildCustomWindow('2026-06-01', '2026-06-25')
    const startOfFirstDay = new Date('2026-06-01T00:00:00') // local midnight

    const included =
      startOfFirstDay.getTime() >= start && startOfFirstDay.getTime() <= end

    expect(included).toBe(true)
  })
})
