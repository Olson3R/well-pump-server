/**
 * Temperature unit preference + formatting helpers shared across the UI and
 * the summary-report Pushover body.
 *
 * The ESP32 stores temperatures in Fahrenheit (despite the README example
 * showing Celsius — sensor readings arrive ~60°F, not 60°C which would be
 * unsurvivable in a pump house). So 'F' is pass-through and 'C' converts.
 */

export type TemperatureUnit = 'C' | 'F'

/** Fahrenheit by default — most well-pump installs are US residential. */
export const DEFAULT_TEMPERATURE_UNIT: TemperatureUnit = 'F'

/** Validate an arbitrary value and coerce to a known unit (default F). */
export function toTemperatureUnit(raw: unknown): TemperatureUnit {
  return raw === 'C' ? 'C' : 'F'
}

/**
 * Convert a stored Fahrenheit reading into the target display unit.
 * F is pass-through; C does (f - 32) × 5/9.
 */
export function convertTemperature(fahrenheit: number, unit: TemperatureUnit): number {
  if (unit === 'F') return fahrenheit
  return (fahrenheit - 32) * 5 / 9
}

/**
 * Format a stored Fahrenheit reading for display in the given unit, with one
 * decimal place and the unit suffix. e.g. formatTemperature(60, 'C') => '15.6°C'.
 */
export function formatTemperature(fahrenheit: number, unit: TemperatureUnit): string {
  const value = convertTemperature(fahrenheit, unit).toFixed(1)
  return `${value}°${unit}`
}

/** "°F" or "°C" — for chart axis labels and table column headers. */
export function temperatureUnitSuffix(unit: TemperatureUnit): string {
  return `°${unit}`
}
