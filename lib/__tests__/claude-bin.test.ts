import { describe, it, expect } from 'vitest'
import path from 'path'
import { resolveClaudeBin, resolveSpawnShell, resolveClaudeSpawn } from '../claude-bin'

describe('resolveClaudeBin()', () => {
  it('returns "claude" on Linux', () => {
    expect(resolveClaudeBin('linux')).toBe('claude')
  })

  it('returns "claude" on macOS', () => {
    expect(resolveClaudeBin('darwin')).toBe('claude')
  })

  it('returns APPDATA npm claude.cmd path on Windows', () => {
    expect(resolveClaudeBin('win32', 'C:\\Users\\Test\\AppData\\Roaming')).toBe(
      path.join('C:\\Users\\Test\\AppData\\Roaming', 'npm', 'claude.cmd'),
    )
  })

  it('falls back to default when APPDATA is undefined', () => {
    expect(resolveClaudeBin('win32', undefined)).toContain('AppData\\Roaming')
  })

  it('falls back to default when APPDATA is empty string', () => {
    expect(resolveClaudeBin('win32', '')).toContain('AppData\\Roaming')
  })
})

describe('resolveSpawnShell()', () => {
  it('returns true on Windows', () => {
    expect(resolveSpawnShell('win32')).toBe(true)
  })

  it('returns false on Linux', () => {
    expect(resolveSpawnShell('linux')).toBe(false)
  })

  it('returns false on macOS', () => {
    expect(resolveSpawnShell('darwin')).toBe(false)
  })
})

describe('resolveClaudeSpawn()', () => {
  it('targets claude.exe directly on Windows — bypasses cmd.exe', () => {
    const { exe, shell } = resolveClaudeSpawn(['-p', 'hello'], 'win32', 'C:\\Users\\Keanu Gomes\\AppData\\Roaming')
    expect(exe).toContain('claude.exe')
    expect(exe).toContain('Keanu Gomes')
    expect(shell).toBe(false)
  })

  it('includes the full path to claude.exe under @anthropic-ai/claude-code/bin', () => {
    const { exe } = resolveClaudeSpawn([], 'win32', 'C:\\Users\\Test\\AppData\\Roaming')
    expect(exe).toContain(path.join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'))
  })

  it('passes claude args unchanged on Windows', () => {
    const claudeArgs = ['-p', 'hello', '--system-prompt', 'line1\nline2\nline3']
    const { args } = resolveClaudeSpawn(claudeArgs, 'win32', 'C:\\Users\\Test\\AppData\\Roaming')
    expect(args).toEqual(claudeArgs)
  })

  it('preserves newlines in args — no cmd.exe encoding needed', () => {
    const { args } = resolveClaudeSpawn(['--system-prompt', 'line1\nline2'], 'win32', 'C:\\Users\\Test\\AppData\\Roaming')
    expect(args[1]).toBe('line1\nline2')
  })

  it('passes args through directly on Linux', () => {
    const { exe, args, shell } = resolveClaudeSpawn(['-p', 'hello'], 'linux')
    expect(exe).toBe('claude')
    expect(args).toEqual(['-p', 'hello'])
    expect(shell).toBe(false)
  })

  it('passes args through directly on macOS', () => {
    const { exe, args, shell } = resolveClaudeSpawn(['-p', 'hello'], 'darwin')
    expect(exe).toBe('claude')
    expect(args).toEqual(['-p', 'hello'])
    expect(shell).toBe(false)
  })

  it('never sets shell: true on any platform', () => {
    expect(resolveClaudeSpawn([], 'win32', 'C:\\Test').shell).toBe(false)
    expect(resolveClaudeSpawn([], 'linux').shell).toBe(false)
    expect(resolveClaudeSpawn([], 'darwin').shell).toBe(false)
  })
})
