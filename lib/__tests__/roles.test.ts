import { describe, it, expect } from 'vitest'
import { ROLES, ROLE_IDS, DEFAULT_ROLE } from '../roles'

describe('roles', () => {
  it('exports all five role IDs', () => {
    expect(ROLE_IDS).toHaveLength(5)
    expect(ROLE_IDS).toContain('RAZ-Dev')
    expect(ROLE_IDS).toContain('RAZ-Sec')
    expect(ROLE_IDS).toContain('RAZ-QA')
    expect(ROLE_IDS).toContain('RAZ-Ops')
    expect(ROLE_IDS).toContain('RAZ-Data')
  })

  it('every role has required fields with correct shape', () => {
    for (const id of ROLE_IDS) {
      const role = ROLES[id]
      expect(role.id).toBe(id)
      expect(typeof role.label).toBe('string')
      expect(typeof role.badge).toBe('string')
      expect(role.badge.length).toBeGreaterThan(0)
      expect(typeof role.color).toBe('string')
      expect(Array.isArray(role.allowedTools)).toBe(true)
      expect(role.allowedTools.length).toBeGreaterThan(0)
      expect(Array.isArray(role.extraGates)).toBe(true)
      expect(typeof role.commitPrefix).toBe('string')
      expect(typeof role.systemContext).toBe('string')
    }
  })

  it('DEFAULT_ROLE is RAZ-Dev', () => {
    expect(DEFAULT_ROLE).toBe('RAZ-Dev')
  })

  it('RAZ-QA extraGates require run_tests and check_coverage', () => {
    expect(ROLES['RAZ-QA'].extraGates).toContain('run_tests')
    expect(ROLES['RAZ-QA'].extraGates).toContain('check_coverage')
  })

  it('RAZ-Dev allows write and execution tools', () => {
    const devTools = ROLES['RAZ-Dev'].allowedTools
    expect(devTools).toContain('write_file')
    expect(devTools).toContain('execute_bash')
    expect(devTools).toContain('run_build')
    expect(devTools).toContain('run_tests')
    expect(devTools).toContain('security_scan')
  })

  it('RAZ-Sec is read-only (no write_file or execute_bash)', () => {
    const secTools = ROLES['RAZ-Sec'].allowedTools
    expect(secTools).not.toContain('write_file')
    expect(secTools).not.toContain('execute_bash')
  })

  it('RAZ-Dev buildRequired is true', () => {
    expect(ROLES['RAZ-Dev'].buildRequired).toBe(true)
  })

  it('RAZ-Sec securityRequired is true', () => {
    expect(ROLES['RAZ-Sec'].securityRequired).toBe(true)
  })

  it('RAZ-QA has PR review tools for code review workflow', () => {
    const tools = ROLES['RAZ-QA'].allowedTools
    expect(tools).toContain('list_open_prs')
    expect(tools).toContain('get_pr_summary')
    expect(tools).toContain('get_pr_file_diff')
    expect(tools).toContain('post_pr_review')
  })

  it('RAZ-Sec and RAZ-Ops can read PRs but not post reviews', () => {
    expect(ROLES['RAZ-Sec'].allowedTools).toContain('get_pr_summary')
    expect(ROLES['RAZ-Sec'].allowedTools).not.toContain('post_pr_review')
    expect(ROLES['RAZ-Ops'].allowedTools).toContain('get_pr_summary')
    expect(ROLES['RAZ-Ops'].allowedTools).not.toContain('post_pr_review')
  })

  it('RAZ-QA systemContext mentions both review and audit workflows', () => {
    const ctx = ROLES['RAZ-QA'].systemContext
    expect(ctx).toContain('PRE-MERGE REVIEW WORKFLOW')
    expect(ctx).toContain('POST-MERGE AUDIT WORKFLOW')
    expect(ctx).toContain('get_pr_summary')
    expect(ctx).toContain('get_pr_file_diff')
    expect(ctx).toContain('post_pr_review')
  })

  it('write-capable roles include security_scan', () => {
    expect(ROLES['RAZ-Dev'].allowedTools).toContain('security_scan')
    expect(ROLES['RAZ-Data'].allowedTools).toContain('security_scan')
  })
})
