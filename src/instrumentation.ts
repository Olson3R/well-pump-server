export async function register() {
  // Only run scheduler on the server side
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const cron = await import('node-cron')
    const { cleanupOldData } = await import('./lib/cleanup')

    // Validate notification configuration at startup so any misconfiguration
    // (missing Pushover / VAPID credentials) surfaces in the logs immediately
    // instead of being discovered when an alert silently fails to deliver.
    const { validateNotificationConfig } = await import('./lib/notifications')
    validateNotificationConfig()

    // Schedule cleanup to run daily at 2:00 AM
    cron.default.schedule('0 2 * * *', async () => {
      console.log('[Scheduler] Running daily data cleanup...')
      const result = await cleanupOldData(2) // 2 months retention
      if (result.success) {
        console.log(`[Scheduler] Cleanup completed: ${result.sensorDataDeleted} sensor records, ${result.eventsDeleted} events deleted`)
      } else {
        console.error(`[Scheduler] Cleanup failed: ${result.error}`)
      }
    })

    console.log('[Scheduler] Daily cleanup task scheduled for 2:00 AM')

    // Hourly tick that delivers any opted-in user's summary report at the top
    // of their configured local hour. Per-user idempotency lives inside
    // `runDueSummaryReports` so a missed/repeated tick is safe.
    const { runDueSummaryReports } = await import('./lib/summary-report')
    cron.default.schedule('0 * * * *', async () => {
      try {
        const results = await runDueSummaryReports()
        if (results.length > 0) {
          const delivered = results.filter((r) => r.delivered).length
          console.log(
            `[Scheduler] Summary reports: ${delivered}/${results.length} delivered`,
          )
        }
      } catch (error) {
        console.error('[Scheduler] Summary report tick failed:', error)
      }
    })

    console.log('[Scheduler] Hourly summary-report tick scheduled')

    // Per-minute MISSING_DATA sweep. Sensor stream cadence is ~1 row/minute,
    // so a 1-min tick keeps detection latency aligned with the data cadence.
    // The check itself is self-guarding and never throws.
    const { checkMissingData } = await import('./lib/threshold-detection')
    cron.default.schedule('* * * * *', async () => {
      await checkMissingData()
    })

    console.log('[Scheduler] Per-minute missing-data tick scheduled')
  }
}
