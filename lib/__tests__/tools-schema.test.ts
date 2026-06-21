import { describe, it, expect } from 'vitest'
import { TOOLS } from '../tools'

const toolNames = TOOLS.map((t) => t.name)

describe('TOOLS schema', () => {
  it('every tool has name, description, and input_schema', () => {
    for (const tool of TOOLS) {
      expect(typeof tool.name).toBe('string')
      expect(tool.name.length).toBeGreaterThan(0)
      expect(typeof tool.description).toBe('string')
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.input_schema).toBeDefined()
      expect(tool.input_schema.type).toBe('object')
      expect(Array.isArray(tool.input_schema.required)).toBe(true)
    }
  })

  it('contains all PR review tools added in the efficiency overhaul', () => {
    expect(toolNames).toContain('list_open_prs')
    expect(toolNames).toContain('get_pr_summary')
    expect(toolNames).toContain('get_pr_file_diff')
    expect(toolNames).toContain('post_pr_review')
  })

  it('get_pr_summary requires pr_number', () => {
    const tool = TOOLS.find((t) => t.name === 'get_pr_summary')!
    expect(tool.input_schema.required).toContain('pr_number')
  })

  it('get_pr_file_diff requires pr_number and filename', () => {
    const tool = TOOLS.find((t) => t.name === 'get_pr_file_diff')!
    expect(tool.input_schema.required).toContain('pr_number')
    expect(tool.input_schema.required).toContain('filename')
  })

  it('post_pr_review requires pr_number, body, and verdict', () => {
    const tool = TOOLS.find((t) => t.name === 'post_pr_review')!
    expect(tool.input_schema.required).toContain('pr_number')
    expect(tool.input_schema.required).toContain('body')
    expect(tool.input_schema.required).toContain('verdict')
  })

  it('contains core read and write tools', () => {
    expect(toolNames).toContain('read_file')
    expect(toolNames).toContain('write_file')
    expect(toolNames).toContain('search_codebase')
    expect(toolNames).toContain('execute_bash')
    expect(toolNames).toContain('run_build')
    expect(toolNames).toContain('run_tests')
  })

  it('contains agent coordination tools', () => {
    expect(toolNames).toContain('create_plan')
    expect(toolNames).toContain('save_memory')
    expect(toolNames).toContain('delegate_to_role')
    expect(toolNames).toContain('handoff_to_role')
    expect(toolNames).toContain('task_complete')
  })

  it('has no duplicate tool names', () => {
    const seen = new Set<string>()
    for (const name of toolNames) {
      expect(seen.has(name), `Duplicate tool: ${name}`).toBe(false)
      seen.add(name)
    }
  })
})
