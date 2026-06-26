import { NextRequest, NextResponse } from 'next/server'
import { getConfig, setConfig, getAllConfig } from '@/lib/db'
import { getActiveAgentRunner, getAvailableAgentRunners, isAgentRunnerAvailable, normalizeAgentRunner } from '@/lib/agent'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key')
  if (key) return NextResponse.json({ value: getConfig(key) })
  return NextResponse.json({
    ...getAllConfig(),
    agent_runner:            getActiveAgentRunner(),
    available_agent_runners: getAvailableAgentRunners(),
  })
}

export async function POST(req: NextRequest) {
  const { key, value } = await req.json().catch(() => ({}))
  if (!key || value === undefined) return NextResponse.json({ error: 'Missing key or value' }, { status: 400 })

  const configuredToken = process.env.RAZ_CONFIG_TOKEN
  if (configuredToken && req.headers.get('x-raz-config-token') !== configuredToken) {
    return NextResponse.json({ error: 'Config write is not authorized.' }, { status: 403 })
  }

  const configKey   = String(key)
  const configValue = String(value)

  if (configKey === 'raz_mode') {
    if (!['standard', 'supervised', 'autonomous'].includes(configValue)) {
      return NextResponse.json({ error: 'Invalid RAZ mode.' }, { status: 400 })
    }
  } else if (configKey === 'task_paused') {
    if (!['0', '1'].includes(configValue)) {
      return NextResponse.json({ error: 'Invalid pause state.' }, { status: 400 })
    }
  } else if (configKey === 'agent_runner') {
    const runner = normalizeAgentRunner(configValue)
    if (!runner) return NextResponse.json({ error: 'Invalid agent runner.' }, { status: 400 })
    if (!isAgentRunnerAvailable(runner)) {
      return NextResponse.json({ error: 'Agent runner is not available on this server.' }, { status: 400 })
    }
    setConfig(configKey, runner)
    return NextResponse.json({ ok: true, agent_runner: runner, available_agent_runners: getAvailableAgentRunners() })
  } else {
    return NextResponse.json({ error: 'Unknown config key.' }, { status: 400 })
  }

  setConfig(configKey, configValue)
  return NextResponse.json({ ok: true })
}
