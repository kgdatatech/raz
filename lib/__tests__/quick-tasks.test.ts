import { describe, expect, it } from 'vitest'
import { getAgentsDocumentationPreset } from '../quick-tasks'

describe('AGENTS.md quick-task routing', () => {
  it('routes Standard mode directly to a write-capable role', () => {
    const preset = getAgentsDocumentationPreset('standard', 'scaffold')

    expect(preset.role).toBe('RAZ-Dev')
    expect(preset.workflow).toBe('feature')
    expect(preset.desc).toContain('Create or update AGENTS.md')
    expect(preset.desc).toContain('do not create a QA handoff')
  })

  it.each(['supervised', 'autonomous'] as const)(
    'routes %s mode through an Ops survey and automatic Dev handoff',
    (mode) => {
      const preset = getAgentsDocumentationPreset(mode, 'scaffold')

      expect(preset.role).toBe('RAZ-Ops')
      expect(preset.workflow).toBe('strategy')
      expect(preset.desc).toContain('Do not edit files')
      expect(preset.desc).toContain('hand off to RAZ-Dev')
      expect(preset.desc).toContain('workflow=feature')
    },
  )

  it('supports the Raziel-specific AGENTS.md update preset', () => {
    const preset = getAgentsDocumentationPreset('standard', 'update-raz')

    expect(preset.role).toBe('RAZ-Dev')
    expect(preset.desc).toContain('available MCP tools')
    expect(preset.desc).toContain('operating modes')
  })
})
