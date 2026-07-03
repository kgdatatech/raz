import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.hoisted(() => {
  process.env['RAZ_DB_PATH'] = ':memory:'
})

import db, { setConfig } from '@/lib/db'
import {
  getModelForRole, getConfiguredModelForRole, getModelPricing, isSupportedModel, isModelConfigKey,
  SUPPORTED_MODELS, DEFAULT_MODEL,
} from '@/lib/models'

function clearModelConfig() {
  db.prepare(`DELETE FROM system_config WHERE key = 'agent_model' OR key LIKE 'agent_model_%'`).run()
}

describe('isSupportedModel()', () => {
  it('accepts every model in the catalog', () => {
    for (const id of Object.keys(SUPPORTED_MODELS)) {
      expect(isSupportedModel(id)).toBe(true)
    }
  })

  it('rejects unknown and date-suffixed IDs', () => {
    expect(isSupportedModel('claude-sonnet-4-6-20251114')).toBe(false)
    expect(isSupportedModel('gpt-4o')).toBe(false)
    expect(isSupportedModel('')).toBe(false)
  })
})

describe('isModelConfigKey()', () => {
  it('accepts the global key and per-role keys', () => {
    expect(isModelConfigKey('agent_model')).toBe(true)
    expect(isModelConfigKey('agent_model_RAZ-Dev')).toBe(true)
    expect(isModelConfigKey('agent_model_RAZ-QA')).toBe(true)
  })

  it('rejects keys for unknown roles', () => {
    expect(isModelConfigKey('agent_model_RAZ-Bogus')).toBe(false)
    expect(isModelConfigKey('agent_model_')).toBe(false)
    expect(isModelConfigKey('other_key')).toBe(false)
  })
})

describe('getModelForRole()', () => {
  beforeEach(clearModelConfig)

  it('returns the built-in default when nothing is configured', () => {
    expect(getModelForRole('RAZ-Dev')).toBe(DEFAULT_MODEL)
    expect(getModelForRole()).toBe(DEFAULT_MODEL)
  })

  it('uses the global agent_model when set', () => {
    setConfig('agent_model', 'claude-opus-4-8')
    expect(getModelForRole('RAZ-Dev')).toBe('claude-opus-4-8')
    expect(getModelForRole('RAZ-QA')).toBe('claude-opus-4-8')
  })

  it('prefers the per-role override over the global default', () => {
    setConfig('agent_model', 'claude-opus-4-8')
    setConfig('agent_model_RAZ-QA', 'claude-haiku-4-5')
    expect(getModelForRole('RAZ-QA')).toBe('claude-haiku-4-5')
    expect(getModelForRole('RAZ-Dev')).toBe('claude-opus-4-8')
  })

  it('ignores an invalid per-role value and falls through', () => {
    setConfig('agent_model', 'claude-opus-4-8')
    setConfig('agent_model_RAZ-Dev', 'not-a-model')
    expect(getModelForRole('RAZ-Dev')).toBe('claude-opus-4-8')
  })

  it('ignores an invalid global value and falls back to the default', () => {
    setConfig('agent_model', 'claude-sonnet-4-6-20251114')
    expect(getModelForRole('RAZ-Dev')).toBe(DEFAULT_MODEL)
  })
})

describe('getConfiguredModelForRole()', () => {
  beforeEach(clearModelConfig)

  it('returns null when nothing is explicitly configured (CC runner keeps CLI default)', () => {
    expect(getConfiguredModelForRole('RAZ-Dev')).toBeNull()
    expect(getConfiguredModelForRole()).toBeNull()
  })

  it('returns the configured model when set', () => {
    setConfig('agent_model', 'claude-opus-4-8')
    expect(getConfiguredModelForRole('RAZ-Dev')).toBe('claude-opus-4-8')
  })

  it('prefers the per-role override', () => {
    setConfig('agent_model', 'claude-opus-4-8')
    setConfig('agent_model_RAZ-QA', 'claude-haiku-4-5')
    expect(getConfiguredModelForRole('RAZ-QA')).toBe('claude-haiku-4-5')
  })

  it('returns null when only an invalid value is configured', () => {
    setConfig('agent_model', 'not-a-model')
    expect(getConfiguredModelForRole('RAZ-Dev')).toBeNull()
  })
})

describe('getModelPricing()', () => {
  it('returns catalog pricing for known models', () => {
    expect(getModelPricing('claude-haiku-4-5').inputPerM).toBe(1)
    expect(getModelPricing('claude-opus-4-8').outputPerM).toBe(25)
    expect(getModelPricing('claude-fable-5').inputPerM).toBe(10)
  })

  it('falls back to default-model pricing for unknown IDs', () => {
    const fallback = getModelPricing('unknown-model')
    expect(fallback).toEqual(SUPPORTED_MODELS[DEFAULT_MODEL])
  })

  it('keeps cache pricing ratios consistent (~0.1x read, ~1.25x write)', () => {
    for (const pricing of Object.values(SUPPORTED_MODELS)) {
      expect(pricing.cacheReadPerM).toBeCloseTo(pricing.inputPerM * 0.1, 6)
      expect(pricing.cacheWritePerM).toBeCloseTo(pricing.inputPerM * 1.25, 6)
    }
  })
})
