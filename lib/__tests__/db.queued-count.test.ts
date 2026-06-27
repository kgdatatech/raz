import { vi, describe, it, expect, beforeEach } from 'vitest'

/**
 * Use an isolated in-memory SQLite database for every test run.
 * vi.hoisted() executes BEFORE static imports are resolved, so
 * lib/db.ts reads the env var and never touches .raziel/raziel.db.
 */
vi.hoisted(() => {
  process.env['RAZ_DB_PATH'] = ':memory:'
})

import db, {
  countQueuedTasks,
  claimNextQueuedTask,
  completeTask,
  createQueuedTask,
  createTask,
  upsertRepo,
} from '@/lib/db'

describe('countQueuedTasks()', () => {
  beforeEach(() => {
    // FK constraint: tasks.repo_id → repos.id  — clear tasks first
    db.prepare('DELETE FROM tasks').run()
    db.prepare('DELETE FROM repos').run()
  })

  it('returns 0 when the tasks table is empty', () => {
    expect(countQueuedTasks()).toBe(0)
  })

  it('returns 0 when tasks exist but none have status=queued', () => {
    const repo = upsertRepo('owner', 'repo', 'main')
    // createTask defaults to status='running'
    createTask('t-running', repo.id, 'a running task', 'branch-run')
    expect(countQueuedTasks()).toBe(0)
  })

  it('counts a single queued task', () => {
    const repo = upsertRepo('owner', 'repo', 'main')
    createQueuedTask('t-q1', repo.id, 'first queued', 'branch-q1')
    expect(countQueuedTasks()).toBe(1)
  })

  it('counts multiple queued tasks correctly', () => {
    const repo = upsertRepo('owner', 'repo', 'main')
    createQueuedTask('t-q1', repo.id, 'first queued',  'branch-q1')
    createQueuedTask('t-q2', repo.id, 'second queued', 'branch-q2')
    createQueuedTask('t-q3', repo.id, 'third queued',  'branch-q3')
    expect(countQueuedTasks()).toBe(3)
  })

  it('ignores tasks with status running, failed, and complete', () => {
    const repo = upsertRepo('owner', 'repo', 'main')

    createQueuedTask('t-q', repo.id, 'queued task',   'branch-q')   // queued ← counted

    createTask('t-r', repo.id, 'running task', 'branch-r')          // running (default)

    createTask('t-f', repo.id, 'failed task', 'branch-f')
    db.prepare("UPDATE tasks SET status = 'failed' WHERE id = 't-f'").run()

    createTask('t-c', repo.id, 'complete task', 'branch-c')
    db.prepare("UPDATE tasks SET status = 'complete' WHERE id = 't-c'").run()

    expect(countQueuedTasks()).toBe(1)
  })

  it('count decrements when a queued task transitions to running', () => {
    const repo = upsertRepo('owner', 'repo', 'main')
    createQueuedTask('t-q4', repo.id, 'will be dequeued', 'branch-q4')
    expect(countQueuedTasks()).toBe(1)

    db.prepare("UPDATE tasks SET status = 'running' WHERE id = 't-q4'").run()
    expect(countQueuedTasks()).toBe(0)
  })

  it('returns a number type (not string, null, or NaN)', () => {
    const result = countQueuedTasks()
    expect(typeof result).toBe('number')
    expect(result).not.toBeNaN()
    expect(result).toBeGreaterThanOrEqual(0)
  })
})

describe('claimNextQueuedTask()', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM tasks').run()
    db.prepare('DELETE FROM repos').run()
  })

  it('atomically gives a queued task to only one worker', () => {
    const repo = upsertRepo('owner', 'repo', 'main')
    createQueuedTask('claim-me', repo.id, 'claim once', 'branch')

    const first = claimNextQueuedTask('worker-a')
    const second = claimNextQueuedTask('worker-b')

    expect(first?.id).toBe('claim-me')
    expect(first?.status).toBe('running')
    expect(first?.worker_id).toBe('worker-a')
    expect(first?.attempt).toBe(1)
    expect(second).toBeNull()
  })

  it('clears lease ownership and stale errors when completed', () => {
    const repo = upsertRepo('owner', 'repo', 'main')
    createQueuedTask('finish-me', repo.id, 'finish once', 'branch')
    claimNextQueuedTask('worker-a')
    db.prepare(`UPDATE tasks SET error = 'old error' WHERE id = 'finish-me'`).run()

    completeTask('finish-me', null, 'done', [])

    const row = db.prepare(`
      SELECT status, error, worker_id, lease_expires_at, heartbeat_at
      FROM tasks WHERE id = 'finish-me'
    `).get() as Record<string, string | null>
    expect(row).toEqual({
      status: 'complete',
      error: null,
      worker_id: null,
      lease_expires_at: null,
      heartbeat_at: null,
    })
  })
})
