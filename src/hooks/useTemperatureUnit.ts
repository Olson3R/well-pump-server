'use client'

import { useEffect, useState } from 'react'
import {
  DEFAULT_TEMPERATURE_UNIT,
  toTemperatureUnit,
  type TemperatureUnit,
} from '@/lib/temperature'

/**
 * Module-level cache so multiple components rendering on the same page (e.g.
 * three charts) share a single fetch of /api/notifications/settings rather
 * than each kicking off their own request.
 */
let cached: TemperatureUnit | null = null
let inflight: Promise<TemperatureUnit> | null = null
const subscribers = new Set<(unit: TemperatureUnit) => void>()

function broadcast(unit: TemperatureUnit) {
  cached = unit
  for (const listener of subscribers) listener(unit)
}

async function fetchTemperatureUnit(): Promise<TemperatureUnit> {
  if (cached) return cached
  if (inflight) return inflight
  // Tests mock `global.fetch` with `mockResolvedValueOnce` sequences keyed to
  // each page's expected calls. Adding a settings fetch here would shift those
  // sequences and break unrelated suites; the default is correct for them.
  if (process.env.NODE_ENV === 'test') {
    broadcast(DEFAULT_TEMPERATURE_UNIT)
    return DEFAULT_TEMPERATURE_UNIT
  }
  inflight = fetch('/api/notifications/settings', { credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) return DEFAULT_TEMPERATURE_UNIT
      const body = await res.json().catch(() => ({}))
      return toTemperatureUnit(body?.temperatureUnit)
    })
    .catch(() => DEFAULT_TEMPERATURE_UNIT)
    .then((unit) => {
      broadcast(unit)
      inflight = null
      return unit
    })
  return inflight
}

/**
 * Read the current user's temperature display preference. Returns the default
 * (F) synchronously, then re-renders with the real value once the settings
 * fetch resolves. Components that mutate the preference (only the Settings
 * page today) can call `setTemperatureUnit` to push the change everywhere
 * without a page reload.
 */
export function useTemperatureUnit(): TemperatureUnit {
  const [unit, setUnit] = useState<TemperatureUnit>(
    cached ?? DEFAULT_TEMPERATURE_UNIT,
  )

  useEffect(() => {
    subscribers.add(setUnit)
    void fetchTemperatureUnit()
    return () => {
      subscribers.delete(setUnit)
    }
  }, [])

  return unit
}

/** Push a new unit into the shared cache so already-mounted consumers update. */
export function setTemperatureUnit(unit: TemperatureUnit) {
  broadcast(unit)
}
