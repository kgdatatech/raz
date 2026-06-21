import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

vi.hoisted(() => {
  process.env['RAZ_DB_PATH'] = ':memory:'
})

vi.mock('child_process', () => ({ execSync: vi.fn() }))

import fs from 'fs'
import { execSync } from 'child_process'
import db, { upsertRepo, upsertIssue } from '@/lib/db'
import {
  scanTodos, scanMissingTests, scanUnqueuedIssues,
  seedHealthTasks,
} from '../health-scan'
import type { RepoRow } from '../db'

// Spies on fs — set up per describe block, restored after each test
let readdirSpy: ReturnType<typeof vi.spyOn>
let existsSpy:  ReturnType<typeof vi.spyOn>

// ── Fixtures ──────────────────────────────────────────────────────────────────

function cleanDb() {
  db.prepare('DELETE FROM memory').run()
  db.prepare('DELETE FROM chat_messages').run()
  db.prepare('DELETE FROM tasks').run()
  db.prepare('DELETE FROM issues').run()
  db.prepare('DELETE FROM repos').run()
}

function makeRepo(id = 1): RepoRow {
  return { id, github_owner: 'owner', github_repo: 'repo', local_path: '/tmp/repo', default_branch: 'master' }
}

// ── scanTodos ─────────────────────────────────────────────────────────────────

describe('scanTodos()', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  it('returns empty array when git grep finds nothing (exit 1)', () => {
    vi.mocked(execSync).mockImplementation(() => { throw { status: 1, stdout: '' } })
    expect(scanTodos('/tmp/repo')).toEqual([])
  })

  it('returns one finding per file that has TODOs', () => {
    vi.mocked(execSync).mockReturnValue(
      'lib/tools.ts:42:// TODO: add error handling\nlib/tools.ts:88:// FIXME: remove this\nlib/db.ts:5:// TODO: migrate schema\n'
    )
    const findings = scanTodos('/tmp/repo')
    expect(findings).toHaveLength(2)
    const files = findings.map((f) => f.description)
    expect(files.some((d) => d.includes('lib/tools.ts'))).toBe(true)
    expect(files.some((d) => d.includes('lib/db.ts'))).toBe(true)
  })

  it('counts multiple TODOs in same file correctly', () => {
    vi.mocked(execSync).mockReturnValue(
      'lib/tools.ts:1:// TODO\nlib/tools.ts:2:// TODO\nlib/tools.ts:3:// FIXME\n'
    )
    const [finding] = scanTodos('/tmp/repo')
    expect(finding!.description).toContain('3 TODO/FIXME comments')
  })

  it('assigns RAZ-Dev fix workflow', () => {
    vi.mocked(execSync).mockReturnValue('lib/foo.ts:1:// TODO: fix me\n')
    const [finding] = scanTodos('/tmp/repo')
    expect(finding!.role).toBe('RAZ-Dev')
    expect(finding!.workflow).toBe('fix')
  })

  it('generates razdev/health-todo-* branch', () => {
    vi.mocked(execSync).mockReturnValue('lib/foo.ts:1:// TODO\n')
    const [finding] = scanTodos('/tmp/repo')
    expect(finding!.branch).toMatch(/^razdev\/health-todo-/)
  })
})

// ── scanMissingTests ──────────────────────────────────────────────────────────

describe('scanMissingTests()', () => {
  beforeEach(() => {
    readdirSpy = vi.spyOn(fs, 'readdirSync')
    existsSpy  = vi.spyOn(fs, 'existsSync')
  })
  afterEach(() => vi.restoreAllMocks())

  it('returns empty when readdirSync throws (lib dir missing)', () => {
    readdirSpy.mockImplementation(() => { throw new Error('ENOENT') })
    expect(scanMissingTests('/tmp/repo')).toEqual([])
  })

  it('returns finding for source file with no test counterpart', () => {
    readdirSpy.mockReturnValue(['tools.ts', 'db.ts'] as unknown as string[])
    existsSpy.mockReturnValue(false)
    const findings = scanMissingTests('/tmp/repo')
    expect(findings).toHaveLength(2)
    expect(findings.some((f) => f.description.includes('lib/tools.ts'))).toBe(true)
    expect(findings.some((f) => f.description.includes('lib/db.ts'))).toBe(true)
  })

  it('skips files that already have a test file', () => {
    readdirSpy.mockReturnValue(['tools.ts', 'db.ts'] as unknown as string[])
    existsSpy.mockImplementation((p) => String(p).includes('tools.test.ts'))
    const findings = scanMissingTests('/tmp/repo')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.description).toContain('lib/db.ts')
  })

  it('skips .d.ts and __-prefixed files', () => {
    readdirSpy.mockReturnValue(['types.d.ts', '__mocks__.ts'] as unknown as string[])
    existsSpy.mockReturnValue(false)
    expect(scanMissingTests('/tmp/repo')).toEqual([])
  })

  it('assigns RAZ-QA test workflow', () => {
    readdirSpy.mockReturnValue(['agent.ts'] as unknown as string[])
    existsSpy.mockReturnValue(false)
    const [finding] = scanMissingTests('/tmp/repo')
    expect(finding!.role).toBe('RAZ-QA')
    expect(finding!.workflow).toBe('test')
  })

  it('generates razqa/health-test-* branch', () => {
    readdirSpy.mockReturnValue(['my-module.ts'] as unknown as string[])
    existsSpy.mockReturnValue(false)
    const [finding] = scanMissingTests('/tmp/repo')
    expect(finding!.branch).toMatch(/^razqa\/health-test-/)
  })
})

// ── scanUnqueuedIssues ────────────────────────────────────────────────────────

describe('scanUnqueuedIssues()', () => {
  beforeEach(() => {
    cleanDb()
    upsertRepo('owner', 'repo', 'master')
  })

  it('returns empty when no open issues', () => {
    const repo = upsertRepo('owner', 'repo', 'master')
    expect(scanUnqueuedIssues(repo.id)).toEqual([])
  })

  it('returns one triage finding when open issues exist', () => {
    const repo = upsertRepo('owner', 'repo', 'master')
    upsertIssue(repo.id, { number: 1, title: 'Bug', body: null, state: 'open', labels: [], assignee: null })
    upsertIssue(repo.id, { number: 2, title: 'Feat', body: null, state: 'open', labels: [], assignee: null })
    const findings = scanUnqueuedIssues(repo.id)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.description).toContain('2 open GitHub issues')
    expect(findings[0]!.role).toBe('RAZ-Ops')
  })
})

// ── seedHealthTasks ───────────────────────────────────────────────────────────

describe('seedHealthTasks()', () => {
  beforeEach(() => {
    cleanDb()
    vi.clearAllMocks()
    vi.mocked(execSync).mockImplementation(() => { throw { status: 1, stdout: '' } }) // no TODOs
    readdirSpy = vi.spyOn(fs, 'readdirSync').mockReturnValue([])  // no lib files
    existsSpy  = vi.spyOn(fs, 'existsSync').mockReturnValue(false)
  })
  afterEach(() => vi.restoreAllMocks())

  it('returns 0 when health scan finds nothing', async () => {
    const repo = upsertRepo('owner', 'repo', 'master', '/tmp/repo')
    expect(await seedHealthTasks(repo)).toBe(0)
  })

  it('creates queued tasks for each finding', async () => {
    readdirSpy.mockReturnValue(['agent.ts', 'db.ts'] as unknown as string[])
    existsSpy.mockReturnValue(false)
    const repo = upsertRepo('owner', 'repo', 'master', '/tmp/repo')

    const count = await seedHealthTasks(repo)
    expect(count).toBe(2)

    const tasks = db.prepare("SELECT * FROM tasks WHERE status = 'queued'").all() as { role: string; workflow: string }[]
    expect(tasks).toHaveLength(2)
    expect(tasks.every((t) => t.role === 'RAZ-QA' && t.workflow === 'test')).toBe(true)
  })

  it('skips findings that were recently completed (dedup)', async () => {
    readdirSpy.mockReturnValue(['agent.ts'] as unknown as string[])
    existsSpy.mockReturnValue(false)
    const repo = upsertRepo('owner', 'repo', 'master', '/tmp/repo')

    // First seed creates the task
    await seedHealthTasks(repo)
    // Complete it so hasRecentCompletion returns true
    const [task] = db.prepare("SELECT * FROM tasks WHERE status = 'queued'").all() as { id: string }[]
    db.prepare("UPDATE tasks SET status = 'complete', completed_at = datetime('now') WHERE id = ?").run(task!.id)

    // Second seed should skip the same finding
    const count2 = await seedHealthTasks(repo)
    expect(count2).toBe(0)
  })
})
