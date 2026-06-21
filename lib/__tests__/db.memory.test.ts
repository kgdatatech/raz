import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.hoisted(() => {
  process.env['RAZ_DB_PATH'] = ':memory:'
})

import db, {
  setMemory, getMemory,
  getRecentChatContext, saveChatMessage,
  hasRunningDuplicate, hasRecentCompletion,
  createQueuedTask, completeTask, upsertRepo,
} from '@/lib/db'

// Clear all tables that reference repos before each test to avoid FK violations
function cleanDb() {
  db.prepare('DELETE FROM memory').run()
  db.prepare('DELETE FROM chat_messages').run()
  db.prepare('DELETE FROM tasks').run()
  db.prepare('DELETE FROM repos').run()
}

describe('setMemory() — value cap', () => {
  beforeEach(cleanDb)

  it('stores short values unchanged', () => {
    const repo = upsertRepo('o', 'r', 'main')
    setMemory(repo.id, 'key', 'short value')
    expect(getMemory(repo.id)['key']).toBe('short value')
  })

  it('truncates values over 400 chars and appends ellipsis', () => {
    const repo = upsertRepo('o', 'r', 'main')
    const long = 'X'.repeat(500)
    setMemory(repo.id, 'key', long)
    const stored = getMemory(repo.id)['key']
    expect(stored).toBeDefined()
    expect(stored!.length).toBeLessThanOrEqual(401) // 400 chars + '…'
    expect(stored).toMatch(/…$/)
  })

  it('stores value of exactly 400 chars unchanged', () => {
    const repo = upsertRepo('o', 'r', 'main')
    const exact = 'Y'.repeat(400)
    setMemory(repo.id, 'key', exact)
    expect(getMemory(repo.id)['key']).toBe(exact)
  })
})

describe('getRecentChatContext() — staleness gate', () => {
  beforeEach(cleanDb)

  it('returns empty string when no messages exist', () => {
    const repo = upsertRepo('o', 'r', 'main')
    expect(getRecentChatContext(repo.id)).toBe('')
  })

  it('returns context for recent messages', () => {
    const repo = upsertRepo('o', 'r', 'main')
    saveChatMessage(repo.id, 'user', 'hello')
    saveChatMessage(repo.id, 'assistant', 'hi there')
    const ctx = getRecentChatContext(repo.id)
    expect(ctx).toContain('User: hello')
    expect(ctx).toContain('Assistant: hi there')
  })

  it('returns empty string when most recent message is older than 30 min', () => {
    const repo = upsertRepo('o', 'r', 'main')
    // Insert a message with a timestamp 31 minutes in the past
    db.prepare(
      `INSERT INTO chat_messages (repo_id, role, content, created_at)
       VALUES (?, 'user', 'old message', datetime('now', '-31 minutes'))`
    ).run(repo.id)
    expect(getRecentChatContext(repo.id)).toBe('')
  })

  it('truncates long message content to 250 chars', () => {
    const repo = upsertRepo('o', 'r', 'main')
    saveChatMessage(repo.id, 'user', 'A'.repeat(500))
    const ctx = getRecentChatContext(repo.id)
    // The truncated content (250 chars) plus label prefix
    expect(ctx.length).toBeLessThan(500)
  })
})

describe('hasRunningDuplicate() and hasRecentCompletion()', () => {
  let repoId: number

  beforeEach(() => {
    cleanDb()
    repoId = upsertRepo('o', 'r', 'main').id
  })

  it('hasRunningDuplicate returns false when no tasks exist', () => {
    expect(hasRunningDuplicate(repoId, 'Build X', 'other-id')).toBe(false)
  })

  it('hasRunningDuplicate returns true when identical task is running', () => {
    createQueuedTask('t1', repoId, 'Build X', 'branch-1')
    db.prepare("UPDATE tasks SET status = 'running' WHERE id = 't1'").run()
    expect(hasRunningDuplicate(repoId, 'Build X', 'other-id')).toBe(true)
  })

  it('hasRunningDuplicate excludes the task being checked', () => {
    createQueuedTask('t1', repoId, 'Build X', 'branch-1')
    db.prepare("UPDATE tasks SET status = 'running' WHERE id = 't1'").run()
    // Same task checking itself — should not be a duplicate
    expect(hasRunningDuplicate(repoId, 'Build X', 't1')).toBe(false)
  })

  it('hasRecentCompletion returns false when no completed tasks', () => {
    expect(hasRecentCompletion(repoId, 'Build X')).toBe(false)
  })

  it('hasRecentCompletion returns true when same task completed recently', () => {
    createQueuedTask('t1', repoId, 'Build X', 'branch-1')
    completeTask('t1', null, 'done', [])
    expect(hasRecentCompletion(repoId, 'Build X')).toBe(true)
  })

  it('hasRecentCompletion returns false for different description', () => {
    createQueuedTask('t1', repoId, 'Build X', 'branch-1')
    completeTask('t1', null, 'done', [])
    expect(hasRecentCompletion(repoId, 'Build Y')).toBe(false)
  })
})
