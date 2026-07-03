import Anthropic from '@anthropic-ai/sdk'
import { ROLE_IDS } from './roles'
import { detectIntent, type DispatchResult } from './dispatch'

// Server-only. page.tsx imports lib/dispatch (pure regex) directly — keep the
// Anthropic SDK out of that module so it stays safe for the client bundle.

export const DISPATCH_MODEL = 'claude-haiku-4-5'

const WORKFLOWS = ['feature', 'fix', 'refactor', 'review', 'audit', 'test', 'strategy', 'self'] as const

const CONFIDENCES = ['high', 'medium', 'low'] as const

const SCHEMA = {
  type: 'object',
  properties: {
    role:       { type: 'string', enum: [...ROLE_IDS] },
    workflow:   { type: 'string', enum: [...WORKFLOWS] },
    confidence: { type: 'string', enum: [...CONFIDENCES] },
    reason:     { type: 'string', description: 'One short sentence explaining the routing choice' },
  },
  required: ['role', 'workflow', 'confidence', 'reason'],
  additionalProperties: false,
} as const

const SYSTEM = `You route engineering task descriptions to the right RAZ specialist agent.

Roles:
- RAZ-Dev — implements features, fixes bugs, refactors code (workflows: feature, fix, refactor, self)
- RAZ-QA — writes/improves tests, checks coverage, reviews pull requests (workflows: test, review)
- RAZ-Sec — read-only security audits: vulnerabilities, secrets, dependencies (workflow: audit)
- RAZ-Ops — build health, infrastructure, planning and gap analysis, ops reports (workflows: strategy, audit)
- RAZ-Data — database schema, migrations, data pipelines (workflows: feature, fix)

Pick the single best role + workflow for the task. Judge intent, not keywords:
"review the security plan" is RAZ-Ops strategy work, not a security audit.
Use confidence "high" only when the intent is unambiguous.`

let anthropic: Anthropic | null = null
function client(): Anthropic {
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return anthropic
}

function isValidResult(value: unknown): value is DispatchResult {
  const v = value as Partial<DispatchResult> | null
  return !!v
    && (ROLE_IDS as readonly string[]).includes(v.role ?? '')
    && (WORKFLOWS as readonly string[]).includes(v.workflow ?? '')
    && (CONFIDENCES as readonly string[]).includes(v.confidence ?? '')
    && typeof v.reason === 'string'
}

// Classifies with Haiku; falls back to the regex rules when no API key is
// configured, the call fails, or the response doesn't validate.
export async function classifyIntent(description: string): Promise<DispatchResult> {
  const fallback = detectIntent(description)
  if (!process.env.ANTHROPIC_API_KEY) return fallback

  try {
    const response = await client().messages.create(
      {
        model:      DISPATCH_MODEL,
        max_tokens: 300,
        system:     SYSTEM,
        output_config: { format: { type: 'json_schema', schema: SCHEMA } },
        messages: [{ role: 'user', content: description.slice(0, 2_000) }],
      },
      { timeout: 8_000, maxRetries: 1 },
    )
    const text = response.content.find((b) => b.type === 'text')?.text ?? ''
    const parsed: unknown = JSON.parse(text)
    if (!isValidResult(parsed)) return fallback
    return parsed
  } catch {
    return fallback
  }
}
