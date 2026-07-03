// Pure model catalog — safe to import from client components.
// DB-dependent resolution (getModelForRole etc.) lives in lib/models.ts.

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

export const MODEL_IDS = Object.keys(SUPPORTED_MODELS)

export const DEFAULT_MODEL = 'claude-sonnet-4-6'

export function isSupportedModel(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_MODELS, model)
}
