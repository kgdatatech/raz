export type { AgentTask, AgentEvent, EventCallback } from './agent-sdk'

export async function runAgent(
  task:     import('./agent-sdk').AgentTask,
  onEvent:  import('./agent-sdk').EventCallback,
  signal?:  AbortSignal,
): Promise<void> {
  if (process.env.RAZ_RUNNER === 'cc') {
    const { runAgent: run } = await import('./agent-cc')
    return run(task, onEvent, signal)
  }
  const { runAgent: run } = await import('./agent-sdk')
  return run(task, onEvent, signal)
}
