import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.hoisted(() => {
  process.env['RAZ_DB_PATH'] = ':memory:'
})

vi.mock('child_process', () => ({ execSync: vi.fn() }))

import { execSync } from 'child_process'
import db, { upsertRepo, upsertIssue } from '@/lib/db'
import {
  scanTodos, scanMissingTests, scanUnqueuedIssues,
  seedHealthTasks, isTestFile, coveredStem, MAX_FINDINGS_PER_CHECK,
} from '../health-scan'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function cleanDb() {
  db.prepare('DELETE FROM memory').run()
  db.prepare('DELETE FROM chat_messages').run()
  db.prepare('DELETE FROM tasks').run()
  db.prepare('DELETE FROM issues').run()
  db.prepare('DELETE FROM repos').run()
}

// Routes the two git commands health-scan issues: ls-files and grep.
function mockGit({ lsFiles = [] as string[], grep = '' } = {}) {
  vi.mocked(execSync).mockImplementation(((cmd: string) => {
    if (String(cmd).includes('ls-files')) return lsFiles.join('\n') + '\n'
    if (grep === '') throw { status: 1, stdout: '' }
    return grep
  }) as typeof execSync)
}

// ── isTestFile / coveredStem ──────────────────────────────────────────────────

describe('isTestFile()', () => {
  it('detects JS/TS test suffixes', () => {
    expect(isTestFile('src/foo.test.ts')).toBe(true)
    expect(isTestFile('src/foo.spec.tsx')).toBe(true)
    expect(isTestFile('src/foo.test.mjs')).toBe(true)
  })

  it('detects Python conventions', () => {
    expect(isTestFile('pkg/test_utils.py')).toBe(true)
    expect(isTestFile('pkg/utils_test.py')).toBe(true)
    expect(isTestFile('conftest.py')).toBe(true)
  })

  it('detects Go convention', () => {
    expect(isTestFile('cmd/main_test.go')).toBe(true)
  })

  it('detects test directories anywhere in the path', () => {
    expect(isTestFile('lib/__tests__/db.ts')).toBe(true)
    expect(isTestFile('packages/core/tests/integration.py')).toBe(true)
    expect(isTestFile('test/helpers.js')).toBe(true)
  })

  it('rejects regular source files', () => {
    expect(isTestFile('src/foo.ts')).toBe(false)
    expect(isTestFile('pkg/utils.py')).toBe(false)
    expect(isTestFile('cmd/main.go')).toBe(false)
    expect(isTestFile('src/contest.py')).toBe(false)
  })
})

describe('coveredStem()', () => {
  it('extracts the covered source stem from each convention', () => {
    expect(coveredStem('lib/__tests__/db.test.ts')).toBe('db')
    expect(coveredStem('src/foo.spec.tsx')).toBe('foo')
    expect(coveredStem('tests/test_utils.py')).toBe('utils')
    expect(coveredStem('pkg/utils_test.py')).toBe('utils')
    expect(coveredStem('cmd/main_test.go')).toBe('main')
  })
})

// ── scanTodos ─────────────────────────────────────────────────────────────────

describe('scanTodos()', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns empty array when git grep finds nothing (exit 1)', () => {
    mockGit({})
    expect(scanTodos('/tmp/repo')).toEqual([])
  })

  it('returns one finding per file that has TODOs', () => {
    mockGit({ grep: 'lib/tools.ts:42:// TODO: add error handling\nlib/tools.ts:88:// FIXME: remove this\nlib/db.ts:5:// TODO: migrate schema\n' })
    const findings = scanTodos('/tmp/repo')
    expect(findings).toHaveLength(2)
    const files = findings.map((f) => f.description)
    expect(files.some((d) => d.includes('lib/tools.ts'))).toBe(true)
    expect(files.some((d) => d.includes('lib/db.ts'))).toBe(true)
  })

  it('counts multiple TODOs in same file correctly', () => {
    mockGit({ grep: 'lib/tools.ts:1:// TODO\nlib/tools.ts:2:// TODO\nlib/tools.ts:3:// FIXME\n' })
    const [finding] = scanTodos('/tmp/repo')
    expect(finding!.description).toContain('3 TODO/FIXME comments')
  })

  it('finds TODOs in non-TypeScript files', () => {
    mockGit({ grep: 'app/models.py:10:# TODO: add index\ncmd/main.go:3:// FIXME: handle error\n' })
    const findings = scanTodos('/tmp/repo')
    expect(findings).toHaveLength(2)
    expect(findings.some((f) => f.description.includes('app/models.py'))).toBe(true)
    expect(findings.some((f) => f.description.includes('cmd/main.go'))).toBe(true)
  })

  it('assigns RAZ-Dev fix workflow', () => {
    mockGit({ grep: 'lib/foo.ts:1:// TODO: fix me\n' })
    const [finding] = scanTodos('/tmp/repo')
    expect(finding!.role).toBe('RAZ-Dev')
    expect(finding!.workflow).toBe('fix')
  })

  it('generates razdev/health-todo-* branch', () => {
    mockGit({ grep: 'lib/foo.ts:1:// TODO\n' })
    const [finding] = scanTodos('/tmp/repo')
    expect(finding!.branch).toMatch(/^razdev\/health-todo-/)
  })

  it('caps findings at MAX_FINDINGS_PER_CHECK', () => {
    const grep = Array.from({ length: 25 }, (_, i) => `src/file${String(i).padStart(2, '0')}.ts:1:// TODO`).join('\n')
    mockGit({ grep })
    expect(scanTodos('/tmp/repo')).toHaveLength(MAX_FINDINGS_PER_CHECK)
  })
})

// ── scanMissingTests ──────────────────────────────────────────────────────────

describe('scanMissingTests()', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns empty when git ls-files fails (not a git repo)', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not a git repository') })
    expect(scanMissingTests('/tmp/repo')).toEqual([])
  })

  it('returns findings for source files with no test counterpart, in any directory layout', () => {
    mockGit({ lsFiles: ['src/tools.ts', 'src/nested/db.ts', 'src/covered.ts', 'src/covered.test.ts'] })
    const findings = scanMissingTests('/tmp/repo')
    expect(findings).toHaveLength(2)
    expect(findings.some((f) => f.description.includes('src/tools.ts'))).toBe(true)
    expect(findings.some((f) => f.description.includes('src/nested/db.ts'))).toBe(true)
  })

  it('supports the Python test convention', () => {
    mockGit({ lsFiles: ['pkg/utils.py', 'pkg/core.py', 'tests/test_utils.py'] })
    const findings = scanMissingTests('/tmp/repo')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.description).toContain('pkg/core.py')
  })

  it('supports the Go test convention', () => {
    mockGit({ lsFiles: ['cmd/main.go', 'cmd/handler.go', 'cmd/main_test.go'] })
    const findings = scanMissingTests('/tmp/repo')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.description).toContain('cmd/handler.go')
  })

  it('queues a single test-setup strategy task when the repo has no tests at all', () => {
    mockGit({ lsFiles: ['src/app.ts', 'src/util.ts', 'README.md'] })
    const findings = scanMissingTests('/tmp/repo')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.role).toBe('RAZ-Ops')
    expect(findings[0]!.workflow).toBe('strategy')
    expect(findings[0]!.description).toContain('No test infrastructure detected')
  })

  it('ignores generated dirs, declaration files, configs, and non-code files', () => {
    mockGit({ lsFiles: [
      'dist/bundle.js', 'node_modules/dep/index.js', 'coverage/report.js',
      'types.d.ts', 'next.config.ts', 'vitest.config.ts',
      'README.md', 'assets/logo.svg', 'src/lib.rs',
      'src/real.ts', 'src/real.test.ts',
    ] })
    expect(scanMissingTests('/tmp/repo')).toEqual([])
  })

  it('returns empty for repos with no recognizable source files', () => {
    mockGit({ lsFiles: ['README.md', 'Makefile', 'docs/guide.md'] })
    expect(scanMissingTests('/tmp/repo')).toEqual([])
  })

  it('caps findings at MAX_FINDINGS_PER_CHECK', () => {
    const sources = Array.from({ length: 25 }, (_, i) => `src/mod${String(i).padStart(2, '0')}.ts`)
    mockGit({ lsFiles: [...sources, 'src/covered.ts', 'src/covered.test.ts'] })
    expect(scanMissingTests('/tmp/repo')).toHaveLength(MAX_FINDINGS_PER_CHECK)
  })

  it('assigns RAZ-QA test workflow and razqa/health-test-* branch', () => {
    mockGit({ lsFiles: ['src/agent.ts', 'src/other.test.ts'] })
    const [finding] = scanMissingTests('/tmp/repo')
    expect(finding!.role).toBe('RAZ-QA')
    expect(finding!.workflow).toBe('test')
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
    mockGit({}) // no tracked files, no TODOs
  })

  it('returns 0 when health scan finds nothing', async () => {
    const repo = upsertRepo('owner', 'repo', 'master', '/tmp/repo')
    expect(await seedHealthTasks(repo)).toBe(0)
  })

  it('creates queued tasks for each finding', async () => {
    mockGit({ lsFiles: ['src/agent.ts', 'src/db.ts', 'src/covered.ts', 'src/covered.test.ts'] })
    const repo = upsertRepo('owner', 'repo', 'master', '/tmp/repo')

    const count = await seedHealthTasks(repo)
    expect(count).toBe(2)

    const tasks = db.prepare("SELECT * FROM tasks WHERE status = 'queued'").all() as { role: string; workflow: string }[]
    expect(tasks).toHaveLength(2)
    expect(tasks.every((t) => t.role === 'RAZ-QA' && t.workflow === 'test')).toBe(true)
  })

  it('skips findings that were recently completed (dedup)', async () => {
    mockGit({ lsFiles: ['src/agent.ts', 'src/covered.ts', 'src/covered.test.ts'] })
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
