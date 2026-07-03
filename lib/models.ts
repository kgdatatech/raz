import { getConfig } from './db'
import { ROLE_IDS } from './roles'
import { SUPPORTED_MODELS, DEFAULT_MODEL, isSupportedModel, type ModelPricing } from './model-catalog'

export { SUPPORTED_MODELS, DEFAULT_MODEL, MODEL_IDS, isSupportedModel, type ModelPricing } from './model-catalog'

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
