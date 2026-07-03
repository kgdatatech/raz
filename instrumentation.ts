export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startQueueRunner } = await import('./lib/queue-runner')
    const { startRetentionSchedule } = await import('./lib/retention')
    startQueueRunner()
    startRetentionSchedule()
  }
}
