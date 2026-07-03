import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest'

const sdkMocks = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: sdkMocks.messagesCreate }
  },
}))

import { classifyIntent, DISPATCH_MODEL } from '@/lib/dispatch-ai'
import { detectIntent } from '@/lib/dispatch'

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY

function mockClassifierResponse(json: unknown) {
  sdkMocks.messagesCreate.mockResolvedValue({
    content: [{ type: 'text', text: typeof json === 'string' ? json : JSON.stringify(json) }],
  })
}

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY
})

describe('classifyIntent()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ANTHROPIC_API_KEY = 'test-key'
  })

  it('returns the model classification when the response validates', async () => {
    mockClassifierResponse({ role: 'RAZ-Ops', workflow: 'strategy', confidence: 'high', reason: 'planning intent' })
    const result = await classifyIntent('review the security plan and propose a roadmap')
    expect(result.role).toBe('RAZ-Ops')
    expect(result.workflow).toBe('strategy')
    expect(sdkMocks.messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: DISPATCH_MODEL }),
      expect.anything(),
    )
  })

  it('falls back to regex when no API key is configured', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const description = 'fix the crash in the login handler'
    const result = await classifyIntent(description)
    expect(result).toEqual(detectIntent(description))
    expect(sdkMocks.messagesCreate).not.toHaveBeenCalled()
  })

  it('falls back to regex when the API call throws', async () => {
    sdkMocks.messagesCreate.mockRejectedValue(new Error('rate limited'))
    const description = 'add tests for the queue runner'
    const result = await classifyIntent(description)
    expect(result).toEqual(detectIntent(description))
  })

  it('falls back to regex when the response contains an unknown role', async () => {
    mockClassifierResponse({ role: 'RAZ-Bogus', workflow: 'fix', confidence: 'high', reason: 'x' })
    const description = 'fix the broken build script'
    const result = await classifyIntent(description)
    expect(result).toEqual(detectIntent(description))
  })

  it('falls back to regex when the response contains an unknown workflow', async () => {
    mockClassifierResponse({ role: 'RAZ-Dev', workflow: 'deploy', confidence: 'high', reason: 'x' })
    const result = await classifyIntent('deploy the application to production')
    expect(result).toEqual(detectIntent('deploy the application to production'))
  })

  it('falls back to regex on non-JSON output', async () => {
    mockClassifierResponse('I think this should go to RAZ-Dev.')
    const description = 'implement dark mode for the dashboard'
    const result = await classifyIntent(description)
    expect(result).toEqual(detectIntent(description))
  })

  it('truncates very long descriptions before sending', async () => {
    mockClassifierResponse({ role: 'RAZ-Dev', workflow: 'feature', confidence: 'medium', reason: 'x' })
    await classifyIntent('build '.repeat(1000))
    const call = sdkMocks.messagesCreate.mock.calls[0]?.[0] as { messages: Array<{ content: string }> }
    expect(call.messages[0]!.content.length).toBeLessThanOrEqual(2_000)
  })
})

describe('detectIntent() — regex fallback baseline', () => {
  it('routes security keywords to RAZ-Sec audit', () => {
    const r = detectIntent('scan the codebase for exposed secrets and vulnerabilities')
    expect(r.role).toBe('RAZ-Sec')
    expect(r.workflow).toBe('audit')
  })

  it('routes test keywords to RAZ-QA', () => {
    const r = detectIntent('improve unit test coverage for the parser')
    expect(r.role).toBe('RAZ-QA')
    expect(r.workflow).toBe('test')
  })

  it('routes bug reports to RAZ-Dev fix', () => {
    const r = detectIntent('the export button is broken on empty datasets')
    expect(r.role).toBe('RAZ-Dev')
    expect(r.workflow).toBe('fix')
  })

  it('defaults to RAZ-Dev feature with low confidence on no signal', () => {
    const r = detectIntent('zzz qqq')
    expect(r.role).toBe('RAZ-Dev')
    expect(r.workflow).toBe('feature')
    expect(r.confidence).toBe('low')
  })
})
