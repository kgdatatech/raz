export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startQueueRunner } = await import('./lib/queue-runner')
    startQueueRunner()
  }
}
