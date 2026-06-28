import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('fs', () => ({
  default: { existsSync: vi.fn().mockReturnValue(false) },
}))
vi.mock('child_process', () => ({
  execFileSync: vi.fn().mockImplementation(() => { throw new Error('not found') }),
}))

import fs from 'fs'
import { execFileSync } from 'child_process'
import { resolveClaudeBin, resolveSpawnShell, resolveClaudeSpawn, clearClaudePathCache } from '../claude-bin'

beforeEach(() => {
  vi.clearAllMocks()
  clearClaudePathCache()
  vi.mocked(fs.existsSync).mockReturnValue(false)
  vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not found') })
})

describe('resolveClaudeBin()', () => {
  it('returns "claude" on Linux', () => {
    expect(resolveClaudeBin('linux')).toBe('claude')
  })

  it('returns "claude" on macOS', () => {
    expect(resolveClaudeBin('darwin')).toBe('claude')
  })

  it('returns APPDATA npm claude.cmd path on Windows', () => {
    const result = resolveClaudeBin('win32', 'C:\\Users\\Test\\AppData\\Roaming')
    expect(result).toContain('claude.cmd')
    expect(result).toContain('AppData\\Roaming')
  })

  it('falls back to default path when APPDATA is undefined', () => {
    expect(resolveClaudeBin('win32', undefined)).toContain('AppData\\Roaming')
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
  it('returns claude with shell:false on Linux', () => {
    const { exe, args, shell } = resolveClaudeSpawn(['-p', 'hello'], 'linux')
    expect(exe).toBe('claude')
    expect(args).toEqual(['-p', 'hello'])
    expect(shell).toBe(false)
  })

  it('returns claude with shell:false on macOS', () => {
    const { exe, shell } = resolveClaudeSpawn(['-p', 'hello'], 'darwin')
    expect(exe).toBe('claude')
    expect(shell).toBe(false)
  })

  it('passes args unchanged on all platforms', () => {
    const claudeArgs = ['-p', 'hello', '--system-prompt', 'line1\nline2\nline3']
    expect(resolveClaudeSpawn(claudeArgs, 'linux').args).toEqual(claudeArgs)
    clearClaudePathCache()
    expect(resolveClaudeSpawn(claudeArgs, 'darwin').args).toEqual(claudeArgs)
  })

  it('preserves newlines in args on Linux — no shell encoding needed', () => {
    const { args } = resolveClaudeSpawn(['--system-prompt', 'line1\nline2'], 'linux')
    expect(args[1]).toBe('line1\nline2')
  })

  describe('on Windows', () => {
    it('uses found .exe with shell:false when a candidate path exists', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) =>
        String(p).endsWith('claude.exe')
      )
      const { exe, shell } = resolveClaudeSpawn(['-p', 'hi'], 'win32', 'C:\\Users\\Test\\AppData\\Roaming', 'C:\\Users\\Test')
      expect(exe).toContain('claude.exe')
      expect(shell).toBe(false)
    })

    it('uses .local/bin path when that is the first match', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) =>
        /\.local[\\/]bin[\\/]claude\.exe$/.test(String(p))
      )
      const { exe } = resolveClaudeSpawn([], 'win32', 'C:\\Users\\Test\\AppData\\Roaming', 'C:\\Users\\Test')
      expect(exe.replace(/\\/g, '/')).toContain('.local/bin/claude.exe')
    })

    it('falls back to PATH discovery via "where" when no candidate exists', () => {
      const whereResult = 'C:\\Users\\Test\\.local\\bin\\claude.exe'
      // existsSync: false for all candidate paths, but true for the where result
      vi.mocked(fs.existsSync).mockImplementation((p) => String(p) === whereResult)
      vi.mocked(execFileSync).mockReturnValue(`${whereResult}\r\n`)
      const { exe, shell } = resolveClaudeSpawn([], 'win32', 'C:\\NoMatch', 'C:\\NoMatch')
      expect(exe).toBe(whereResult)
      expect(shell).toBe(false)
    })

    it('falls back to shell:true when no exe can be found anywhere', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not found') })
      const { exe, shell } = resolveClaudeSpawn(['-p', 'hi'], 'win32', 'C:\\Test', 'C:\\Test')
      expect(exe).toBe('claude')
      expect(shell).toBe(true)
    })

    it('passes args unchanged on Windows regardless of fallback path', () => {
      const claudeArgs = ['-p', 'hello', '--system-prompt', 'line1\nline2']
      const { args } = resolveClaudeSpawn(claudeArgs, 'win32', 'C:\\Test', 'C:\\Test')
      expect(args).toEqual(claudeArgs)
    })

    it('caches the resolved path — does not re-probe on second call', () => {
      // First call: existsSync returns true for the first candidate → caches it
      vi.mocked(fs.existsSync).mockReturnValueOnce(true)
      const first = resolveClaudeSpawn([], 'win32', 'C:\\Test', 'C:\\Users\\Test')
      const callCountAfterFirst = vi.mocked(fs.existsSync).mock.calls.length
      // Second call: must hit cache, not probe again
      const second = resolveClaudeSpawn([], 'win32', 'C:\\Test', 'C:\\Users\\Test')
      expect(vi.mocked(fs.existsSync).mock.calls.length).toBe(callCountAfterFirst)
      expect(first.exe).toBe(second.exe)
    })
  })
})
