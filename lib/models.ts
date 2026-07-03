import { getConfig } from './db'
import { ROLE_IDS } from './roles'

export interface ModelPricing {
  inputPerM:      number
  outputPerM:     number
  cacheReadPerM:  number   // ~0.1× input
  cacheWritePerM: number   // ~1.25× input (5-minute TTL)
}

// Exact current model IDs — no date suffixes. Pricing is USD per million tokens.
export const SUPPORTED_MODELS: Record<string, ModelPricing> = {
  'claude-fable-5':    { inputPerM: 10, outputPerM: 50, cacheReadPerM: 1.00, cacheWritePerM: 12.50 },
  'claude-opus-4-8':   { inputPerM: 5,  outputPerM: 25, cacheReadPerM: 0.50, cacheWritePerM: 6.25 },
  'claude-opus-4-7':   { inputPerM: 5,  outputPerM: 25, cacheReadPerM: 0.50, cacheWritePerM: 6.25 },
  'claude-opus-4-6':   { inputPerM: 5,  outputPerM: 25, cacheReadPerM: 0.50, cacheWritePerM: 6.25 },
  'claude-sonnet-4-6': { inputPerM: 3,  outputPerM: 15, cacheReadPerM: 0.30, cacheWritePerM: 3.75 },
  'claude-haiku-4-5':  { inputPerM: 1,  outputPerM: 5,  cacheReadPerM: 0.10, cacheWritePerM: 1.25 },
}

export const DEFAULT_MODEL = 'claude-sonnet-4-6'

export function isSupportedModel(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_MODELS, model)
}

export function isModelConfigKey(key: string): boolean {
  if (key === 'agent_model') return true
  if (!key.startsWith('agent_model_')) return false
  return (ROLE_IDS as readonly string[]).includes(key.slice('agent_model_'.length))
}

// Explicitly configured model only: per-role override → global default → null.
// Used by the Claude Code runner, where "nothing configured" must mean
// "don't pass --model" so the user's CLI default stays in control.
export function getConfiguredModelForRole(role?: string): string | null {
  if (role) {
    const roleModel = getConfig(`agent_model_${role}`)
    if (roleModel && isSupportedModel(roleModel)) return roleModel
  }
  const globalModel = getConfig('agent_model')
  if (globalModel && isSupportedModel(globalModel)) return globalModel
  return null
}

// Resolution order: per-role override → global default → built-in default.
// Invalid or unknown configured values are ignored, never propagated to the API.
export function getModelForRole(role?: string): string {
  return getConfiguredModelForRole(role) ?? DEFAULT_MODEL
}

export function getModelPricing(model: string): ModelPricing {
  return SUPPORTED_MODELS[model] ?? SUPPORTED_MODELS[DEFAULT_MODEL]!
}
