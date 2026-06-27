import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.hoisted(() => {
  process.env['RAZ_DB_PATH'] = ':memory:'
})

import db, { upsertRepo, setMemory } from '@/lib/db'
import {
  classifyMemoryEntry, descriptionForMemoryEntry, branchForMemoryEntry,
  seedMemoryTasks,
} from '../memory-tasks'
import { PRIORITY } from '@/lib/db'
import type { RepoRow } from '../db'

function cleanDb() {
  db.prepare('DELETE FROM memory').run()
  db.prepare('DELETE FROM chat_messages').run()
  db.prepare('DELETE FROM tasks').run()
  db.prepare('DELETE FROM repos').run()
}

function makeRepo(): RepoRow {
  return upsertRepo('owner', 'repo', 'master', '/tmp/repo')
}

// ── classifyMemoryEntry ───────────────────────────────────────────────────────

describe('classifyMemoryEntry()', () => {
  it('classifies security: prefix -> RAZ-Sec CRITICAL audit', () => {
    const rule = classifyMemoryEntry('security:jwt-no-expiry', 'tokens never expire')
    expect(rule).not.toBeNull()
    expect(rule!.role).toBe('RAZ-Sec')
    expect(rule!.workflow).toBe('audit')
    expect(rule!.priority).toBe(PRIORITY.CRITICAL)
  })

  it('classifies vuln: prefix -> CRITICAL', () => {
    const rule = classifyMemoryEntry('vuln:sql-injection', 'raw query in search')
    expect(rule!.priority).toBe(PRIORITY.CRITICAL)
  })

  it('classifies exposed: prefix -> CRITICAL', () => {
    const rule = classifyMemoryEntry('exposed:api-key', 'key in config.ts')
    expect(rule!.priority).toBe(PRIORITY.CRITICAL)
  })

  it('classifies bug: prefix -> RAZ-Dev HIGH fix', () => {
    const rule = classifyMemoryEntry('bug:login-fails', 'safari session drops')
    expect(rule!.role).toBe('RAZ-Dev')
    expect(rule!.workflow).toBe('fix')
    expect(rule!.priority).toBe(PRIORITY.HIGH)
  })

  it('classifies error: prefix -> HIGH', () => {
    const rule = classifyMemoryEntry('error:500-on-signup', 'null pointer in handler')
    expect(rule!.priority).toBe(PRIORITY.HIGH)
  })

  it('classifies deps: prefix -> RAZ-Ops NORMAL strategy', () => {
    const rule = classifyMemoryEntry('deps:lodash-outdated', 'v3.x, v4 available')
    expect(rule!.role).toBe('RAZ-Ops')
    expect(rule!.workflow).toBe('strategy')
    expect(rule!.priority).toBe(PRIORITY.NORMAL)
  })

  it('classifies test: prefix -> RAZ-QA NORMAL test', () => {
    const rule = classifyMemoryEntry('test:no-auth-coverage', 'auth module untested')
    expect(rule!.role).toBe('RAZ-QA')
    expect(rule!.workflow).toBe('test')
    expect(rule!.priority).toBe(PRIORITY.NORMAL)
  })

  it('classifies todo: prefix -> RAZ-Dev NORMAL feature', () => {
    const rule = classifyMemoryEntry('todo:add-rate-limiting', 'no rate limiting on /api/login')
    expect(rule!.role).toBe('RAZ-Dev')
    expect(rule!.workflow).toBe('feature')
    expect(rule!.priority).toBe(PRIORITY.NORMAL)
  })

  it('classifies data: prefix -> RAZ-Data NORMAL feature', () => {
    const rule = classifyMemoryEntry('data:migration-needed', 'add index on user_id')
    expect(rule!.role).toBe('RAZ-Data')
    expect(rule!.workflow).toBe('feature')
  })

  it('returns null for unrecognised keys (fact-storage)', () => {
    expect(classifyMemoryEntry('last-pr-reviewed', '42')).toBeNull()
    expect(classifyMemoryEntry('build-status', 'passing')).toBeNull()
    expect(classifyMemoryEntry('reviewed-at', '2026-06-01')).toBeNull()
  })

  it('is case-insensitive on key prefix', () => {
    expect(classifyMemoryEntry('SECURITY:xss', 'reflected XSS')).not.toBeNull()
    expect(classifyMemoryEntry('Bug:crash', 'null deref')).not.toBeNull()
  })
})

// ── descriptionForMemoryEntry ─────────────────────────────────────────────────

describe('descriptionForMemoryEntry()', () => {
  it('includes the label, key, and value', () => {
    const desc = descriptionForMemoryEntry('bug:login', 'session drops on mobile', 'Bug finding')
    expect(desc).toContain('Bug finding')
    expect(desc).toContain('bug:login')
    expect(desc).toContain('session drops on mobile')
  })

  it('truncates values longer than 120 chars', () => {
    const long = 'X'.repeat(200)
    const desc = descriptionForMemoryEntry('todo:fix', long, 'Improvement finding')
    expect(desc.length).toBeLessThan(200)
  })
})

// ── branchForMemoryEntry ──────────────────────────────────────────────────────

describe('branchForMemoryEntry()', () => {
  it('produces razdev/memory-* format', () => {
    expect(branchForMemoryEntry('bug:login-fails')).toBe('razdev/memory-bug-login-fails')
  })

  it('strips special chars and collapses hyphens', () => {
    const branch = branchForMemoryEntry('security:xss!!exploit')
    expect(branch).toMatch(/^razdev\/memory-security-xss-exploit/)
  })

  it('truncates long keys to 40 chars in slug', () => {
    const branch = branchForMemoryEntry('todo:' + 'a'.repeat(100))
    const slug = branch.replace('razdev/memory-', '')
    expect(slug.length).toBeLessThanOrEqual(40)
  })
})

// ── seedMemoryTasks ───────────────────────────────────────────────────────────

describe('seedMemoryTasks()', () => {
  let repo: RepoRow

  beforeEach(() => {
    cleanDb()
    repo = makeRepo()
  })

  it('returns zero queued when no memory entries exist', async () => {
    const result = await seedMemoryTasks(repo)
    expect(result.queued).toBe(0)
  })

  it('queues tasks for actionable memory entries', async () => {
    setMemory(repo.id, 'bug:login-crash', 'null pointer on mobile safari')
    setMemory(repo.id, 'security:exposed-key', 'API key in config.ts')

    const result = await seedMemoryTasks(repo)
    expect(result.queued).toBe(2)
    expect(result.skipped).toBe(0)
  })

  it('does not queue tasks for unclassified memory entries', async () => {
    setMemory(repo.id, 'last-pr-reviewed', '42')
    setMemory(repo.id, 'build-status', 'passing')

    const result = await seedMemoryTasks(repo)
    expect(result.queued).toBe(0)
    expect(result.findings.every((f) => f.status === 'unclassified')).toBe(true)
  })

  it('assigns correct priority to queued tasks', async () => {
    setMemory(repo.id, 'security:xss', 'reflected XSS in search param')
    setMemory(repo.id, 'bug:crash', 'null deref on upload')
    setMemory(repo.id, 'todo:rate-limit', 'no rate limiting on login')

    await seedMemoryTasks(repo)

    const tasks = db.prepare(
      "SELECT description, priority FROM tasks WHERE status = 'queued' ORDER BY priority DESC"
    ).all() as { description: string; priority: number }[]

    expect(tasks[0]!.priority).toBe(PRIORITY.CRITICAL) // security
    expect(tasks[1]!.priority).toBe(PRIORITY.HIGH)     // bug
    expect(tasks[2]!.priority).toBe(PRIORITY.NORMAL)   // todo
  })

  it('skips entries whose task was recently completed (dedup)', async () => {
    setMemory(repo.id, 'bug:login', 'session drops')

    // First seed — creates task
    await seedMemoryTasks(repo)
    const [task] = db.prepare("SELECT id FROM tasks").all() as { id: string }[]
    db.prepare("UPDATE tasks SET status = 'complete', completed_at = datetime('now') WHERE id = ?").run(task!.id)

    // Second seed — should be deduped
    const result2 = await seedMemoryTasks(repo)
    expect(result2.queued).toBe(0)
    expect(result2.skipped).toBe(1)
  })

  it('reports unclassified entries separately from skipped', async () => {
    setMemory(repo.id, 'build-status', 'passing')   // unclassified
    setMemory(repo.id, 'bug:crash', 'null deref')   // actionable

    const result = await seedMemoryTasks(repo)
    expect(result.queued).toBe(1)
    const statuses = result.findings.map((f) => f.status)
    expect(statuses).toContain('queued')
    expect(statuses).toContain('unclassified')
  })
})
