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
  }
}
