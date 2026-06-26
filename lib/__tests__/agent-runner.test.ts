import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env['RAZ_DB_PATH'] = ':memory:'
})

import { getAvailableAgentRunners, legacyEnvRunner, normalizeAgentRunner } from '../agent'

describe('agent runner config helpers', () => {
  it('normalizes legacy and current runner names', () => {
    expect(normalizeAgentRunner('cc')).toBe('claude_code')
    expect(normalizeAgentRunner('claude_code')).toBe('claude_code')
    expect(normalizeAgentRunner('sdk')).toBe('sdk')
    expect(normalizeAgentRunner('codex')).toBe('codex')
    expect(normalizeAgentRunner('bad')).toBeNull()
    expect(normalizeAgentRunner(null)).toBeNull()
  })

  it('preserves RAZ_RUNNER=cc as the legacy default', () => {
    const previous = process.env.RAZ_RUNNER
    process.env.RAZ_RUNNER = 'cc'
    expect(legacyEnvRunner()).toBe('claude_code')
    if (previous === undefined) delete process.env.RAZ_RUNNER
    else process.env.RAZ_RUNNER = previous
  })

  it('reports Codex availability from the server runtime', () => {
    expect(typeof getAvailableAgentRunners().find((runner) => runner.id === 'codex')?.available).toBe('boolean')
  })
})
