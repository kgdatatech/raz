import fs from 'fs'
import path from 'path'
import { getConfig } from './db'

export type { AgentTask, AgentEvent, EventCallback } from './agent-sdk'

export const AGENT_RUNNERS = ['sdk', 'claude_code', 'codex'] as const
export type AgentRunner = typeof AGENT_RUNNERS[number]

export interface AgentRunnerOption {
  id:        AgentRunner
  label:     string
  available: boolean
  reason?:   string
}

export function normalizeAgentRunner(value: string | null | undefined): AgentRunner | null {
  if (!value) return null
  const normalized = value === 'cc' ? 'claude_code' : value
  return AGENT_RUNNERS.includes(normalized as AgentRunner) ? normalized as AgentRunner : null
}

export function legacyEnvRunner(): AgentRunner {
  return process.env.RAZ_RUNNER === 'cc' ? 'claude_code' : 'sdk'
}

export function getAvailableAgentRunners(): AgentRunnerOption[] {
  const codexAvailable = Boolean(resolveCodexCommand())
  return [
    {
      id:        'sdk',
      label:     'Claude SDK',
      available: Boolean(process.env.ANTHROPIC_API_KEY),
      reason:    process.env.ANTHROPIC_API_KEY ? undefined : 'ANTHROPIC_API_KEY is not configured.',
    },
    { id: 'claude_code', label: 'Claude Code', available: true },
    {
      id:        'codex',
      label:     'Codex',
      available: codexAvailable,
      reason:    codexAvailable ? undefined : 'Codex CLI was not found. Install Codex CLI or set RAZ_CODEX_COMMAND.',
    },
  ]
}

function resolveCodexCommand(): string | null {
  if (process.env.RAZ_CODEX_COMMAND) return process.env.RAZ_CODEX_COMMAND
  if (process.platform === 'win32') {
    const cmd = path.join(process.env.APPDATA ?? '', 'npm', 'codex.cmd')
    return fs.existsSync(cmd) ? cmd : null
  }
  return 'codex'
}

export function isAgentRunnerAvailable(runner: AgentRunner): boolean {
  return getAvailableAgentRunners().some((option) => option.id === runner && option.available)
}

export function getActiveAgentRunner(): AgentRunner {
  const configured = normalizeAgentRunner(getConfig('agent_runner'))
  return configured ?? legacyEnvRunner()
}

export function assertAgentRunnerAvailable(runner: AgentRunner): void {
  const option = getAvailableAgentRunners().find((item) => item.id === runner)
  if (!option?.available) throw new Error(option?.reason ?? `Agent runner is unavailable: ${runner}`)
}

export async function runAgent(
  task:     import('./agent-sdk').AgentTask,
  onEvent:  import('./agent-sdk').EventCallback,
  signal?:  AbortSignal,
): Promise<void> {
  const runner = normalizeAgentRunner(task.runner) ?? getActiveAgentRunner()
  assertAgentRunnerAvailable(runner)

  if (runner === 'claude_code') {
    const { runAgent: run } = await import('./agent-cc')
    return run({ ...task, runner }, onEvent, signal)
  }
  if (runner === 'codex') {
    const { runAgent: run } = await import('./agent-codex')
    return run({ ...task, runner }, onEvent, signal)
  }
  const { runAgent: run } = await import('./agent-sdk')
  return run({ ...task, runner }, onEvent, signal)
}
