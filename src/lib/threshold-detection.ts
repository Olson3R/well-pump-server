/**
 * Server-side detection of threshold-based alert conditions
 * (HIGH_CURRENT, LOW_PRESSURE, LOW_TEMPERATURE, MISSING_DATA).
 *
 * The ESP32 ships with hardcoded trigger thresholds and emits events when its
 * own values are crossed. That is fine for default behaviour, but the admin
 * needs to be able to tune the trigger values without reflashing firmware —
 * e.g. raise HIGH_CURRENT after a controller upgrade pushes the steady-state
 * RMS higher, or lower LOW_TEMPERATURE for a heated pump house.
 *
 * Detection here uses configurable thresholds stored in `SystemSettings` and
 * runs against the same SensorData stream the dashboard uses. It coexists with
 * device-side events: both sources de-dup against a single active event per
 * (device, type), so misaligned thresholds at most produce one churn of the
 * description/value column rather than duplicate active alerts.
 *
 * Conditions vs. notifications:
 *   - Threshold values live here: GLOBAL system settings (one pump, one truth).
 *   - Per-user opt-in to *receive* each type lives on NotificationSettings and
 *     is honoured by the existing dispatcher in `notifications.ts`.
 */
import { prisma } from '@/lib/prisma'
import { dispatchEventNotifications } from '@/lib/notifications'
import type { EventType } from '@prisma/client'

/**
 * Default thresholds — seeded from the ESP32's known values and the canonical
 * stats thresholds so existing alert behaviour is preserved on first install.
 *  - HIGH_CURRENT: 7.2 A RMS (README example)
 *  - LOW_PRESSURE: 30 PSI (DEFAULT_STATS_THRESHOLDS.pressureThreshold,
 *    standard residential cut-in)
 *  - LOW_TEMPERATURE: 35 °F (above freezing, typical pump-house freeze warning)
 *  - MISSING_DATA: 10 min (sensor stream cadence is ~1 min)
 */
export const DEFAULT_THRESHOLDS = {
  highCurrentAmps: 7.2,
  lowPressurePsi: 30,
  lowTemperatureF: 35,
  missingDataMinutes: 10,
} as const

/** SystemSettings keys used to persist the configurable thresholds. */
export const THRESHOLD_KEYS = {
  highCurrentAmps: 'highCurrentThresholdAmps',
  lowPressurePsi: 'lowPressureThresholdPsi',
  lowTemperatureF: 'lowTemperatureThresholdF',
  missingDataMinutes: 'missingDataTimeoutMinutes',
} as const

export interface Thresholds {
  highCurrentAmps: number
  lowPressurePsi: number
  lowTemperatureF: number
  missingDataMinutes: number
}

/**
 * Parse a stored setting string into a non-negative number, falling back to the
 * default if missing or malformed. A negative value is treated as "disable this
 * check" only by callers — here we still return the default so the API surface
 * is always a real number.
 */
export function parseThreshold(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined) return fallback
  const value = parseFloat(raw)
  if (!Number.isFinite(value) || value < 0) return fallback
  return value
}

/** Load all configurable thresholds in a single round-trip. */
export async function getThresholds(): Promise<Thresholds> {
  try {
    const rows = await prisma.systemSettings.findMany({
      where: { key: { in: Object.values(THRESHOLD_KEYS) } },
    })
    const byKey = new Map(rows.map((r) => [r.key, r.value]))
    return {
      highCurrentAmps: parseThreshold(
        byKey.get(THRESHOLD_KEYS.highCurrentAmps),
        DEFAULT_THRESHOLDS.highCurrentAmps,
      ),
      lowPressurePsi: parseThreshold(
        byKey.get(THRESHOLD_KEYS.lowPressurePsi),
        DEFAULT_THRESHOLDS.lowPressurePsi,
      ),
      lowTemperatureF: parseThreshold(
        byKey.get(THRESHOLD_KEYS.lowTemperatureF),
        DEFAULT_THRESHOLDS.lowTemperatureF,
      ),
      missingDataMinutes: parseThreshold(
        byKey.get(THRESHOLD_KEYS.missingDataMinutes),
        DEFAULT_THRESHOLDS.missingDataMinutes,
      ),
    }
  } catch (error) {
    console.error('[threshold-detection] failed to read settings:', error)
    return { ...DEFAULT_THRESHOLDS }
  }
}

interface SensorRowForDetection {
  current1RMS: number
  current2RMS: number
  pressMin: number
  tempMin: number
}

/**
 * Evaluate every sensor-driven threshold condition for one freshly-saved row
 * and reconcile each against any existing active event. Wrapped in a single
 * try/catch so a bug in any one check can't break sensor ingestion.
 */
export async function checkSensorThresholds(
  device: string,
  location: string,
  row: SensorRowForDetection,
  now: Date = new Date(),
): Promise<void> {
  try {
    const thresholds = await getThresholds()

    // HIGH_CURRENT — peak RMS across either pump branch.
    const peakRms = Math.max(row.current1RMS, row.current2RMS)
    await reconcileCondition({
      device,
      location,
      type: 'HIGH_CURRENT',
      active: peakRms > thresholds.highCurrentAmps,
      value: peakRms,
      threshold: thresholds.highCurrentAmps,
      describe: (v, t) =>
        `Pump RMS current ${v.toFixed(2)} A exceeds threshold ${t.toFixed(2)} A`,
      now,
    })

    // LOW_PRESSURE — uses pressMin so a transient dip within a window still trips.
    await reconcileCondition({
      device,
      location,
      type: 'LOW_PRESSURE',
      active: row.pressMin <= thresholds.lowPressurePsi,
      value: row.pressMin,
      threshold: thresholds.lowPressurePsi,
      describe: (v, t) =>
        `Pressure ${v.toFixed(1)} PSI at or below threshold ${t.toFixed(1)} PSI`,
      now,
    })

    // LOW_TEMPERATURE — sensor stores Fahrenheit; threshold is Fahrenheit too.
    await reconcileCondition({
      device,
      location,
      type: 'LOW_TEMPERATURE',
      active: row.tempMin <= thresholds.lowTemperatureF,
      value: row.tempMin,
      threshold: thresholds.lowTemperatureF,
      describe: (v, t) =>
        `Temperature ${v.toFixed(1)}°F at or below threshold ${t.toFixed(1)}°F`,
      now,
    })
  } catch (error) {
    console.error('[threshold-detection] checkSensorThresholds failed:', error)
  }
}

/**
 * MISSING_DATA detection runs on a separate cron tick (not on sensor ingest —
 * the whole point is that no data has arrived). Walks every device seen in
 * the last 24 hours and fires/resolves a single active event per device based
 * on how stale its most recent row is.
 */
export async function checkMissingData(now: Date = new Date()): Promise<void> {
  try {
    const thresholds = await getThresholds()
    const timeoutMs = thresholds.missingDataMinutes * 60 * 1000
    if (timeoutMs <= 0) return // 0 disables.

    // Devices that have been heard from recently (avoid alerting forever on a
    // decommissioned device whose last row is months old).
    const recent = await prisma.sensorData.findMany({
      where: {
        timestamp: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
      },
      select: { device: true, location: true, timestamp: true },
      orderBy: { timestamp: 'desc' },
    })

    // Keep only the most recent row per device.
    const latestByDevice = new Map<
      string,
      { location: string; timestamp: Date }
    >()
    for (const row of recent) {
      if (!latestByDevice.has(row.device)) {
        latestByDevice.set(row.device, {
          location: row.location,
          timestamp: row.timestamp,
        })
      }
    }

    for (const [device, { location, timestamp }] of latestByDevice) {
      const ageMs = now.getTime() - timestamp.getTime()
      const ageMinutes = ageMs / 60000
      const active = ageMs > timeoutMs
      await reconcileCondition({
        device,
        location,
        type: 'MISSING_DATA',
        active,
        value: ageMinutes,
        threshold: thresholds.missingDataMinutes,
        describe: (v, t) =>
          `No sensor data received in ${Math.round(v)} min ` +
          `(threshold: ${t.toFixed(0)} min)`,
        now,
      })
    }
  } catch (error) {
    console.error('[threshold-detection] checkMissingData failed:', error)
  }
}

interface ReconcileOptions {
  device: string
  location: string
  type: EventType
  active: boolean
  value: number
  threshold: number
  describe: (value: number, threshold: number) => string
  now: Date
}

/**
 * Create-or-update the active event for a (device, type) pair when the
 * condition is active; resolve the active event when the condition clears.
 * Only dispatches notifications on initial detection (create path) so a
 * lingering condition doesn't spam the user every minute.
 */
async function reconcileCondition(opts: ReconcileOptions): Promise<void> {
  const existing = await prisma.event.findFirst({
    where: { device: opts.device, type: opts.type, active: true },
    orderBy: { timestamp: 'desc' },
  })

  if (opts.active) {
    const description = opts.describe(opts.value, opts.threshold)
    if (existing) {
      const duration = BigInt(opts.now.getTime() - existing.startTime.getTime())
      await prisma.event.update({
        where: { id: existing.id },
        data: {
          timestamp: opts.now,
          value: opts.value,
          threshold: opts.threshold,
          duration,
          description,
        },
      })
    } else {
      await prisma.event.create({
        data: {
          device: opts.device,
          location: opts.location,
          type: opts.type,
          timestamp: opts.now,
          startTime: opts.now,
          duration: BigInt(0),
          active: true,
          value: opts.value,
          threshold: opts.threshold,
          description,
        },
      })
      try {
        await dispatchEventNotifications({
          type: opts.type,
          device: opts.device,
          location: opts.location,
          value: opts.value,
          threshold: opts.threshold,
          description,
        })
      } catch (error) {
        console.error(
          `[threshold-detection] notify failed for ${opts.type}:`,
          error,
        )
      }
    }
  } else if (existing) {
    await prisma.event.update({
      where: { id: existing.id },
      data: { active: false, timestamp: opts.now },
    })
  }
}
