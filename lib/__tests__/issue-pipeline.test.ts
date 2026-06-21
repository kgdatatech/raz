import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.hoisted(() => {
  process.env['RAZ_DB_PATH'] = ':memory:'
})

vi.mock('../github', () => ({
  syncIssues: vi.fn(),
}))

import db, {
  upsertRepo, upsertIssue, listIssues,
  createQueuedTask, getTaskForIssue, setTaskIssueNumber,
} from '@/lib/db'
import { syncIssues } from '../github'
import {
  roleFromLabels, workflowFromLabels, branchForIssue, syncAndQueueIssues,
} from '../issue-pipeline'
import type { RepoRow } from '../db'

// ── Helpers ───────────────────────────────────────────────────────────────────

function cleanDb() {
  db.prepare('DELETE FROM memory').run()
  db.prepare('DELETE FROM chat_messages').run()
  db.prepare('DELETE FROM tasks').run()
  db.prepare('DELETE FROM issues').run()
  db.prepare('DELETE FROM repos').run()
}

function makeRepo(): RepoRow {
  return upsertRepo('owner', 'repo', 'master', '/tmp/repo')
}

function seedIssue(repoId: number, number: number, title: string, labels: string[] = []) {
  upsertIssue(repoId, { number, title, body: null, state: 'open', labels, assignee: null })
}

// ── roleFromLabels ────────────────────────────────────────────────────────────

describe('roleFromLabels()', () => {
  it('returns RAZ-Dev for no labels (default)', () => {
    expect(roleFromLabels([])).toBe('RAZ-Dev')
  })

  it('returns RAZ-Dev for enhancement label', () => {
    expect(roleFromLabels(['enhancement'])).toBe('RAZ-Dev')
  })

  it('returns RAZ-Dev for bug label', () => {
    expect(roleFromLabels(['bug'])).toBe('RAZ-Dev')
  })

  it('returns RAZ-QA for test label', () => {
    expect(roleFromLabels(['test'])).toBe('RAZ-QA')
  })

  it('returns RAZ-QA for testing label', () => {
    expect(roleFromLabels(['testing'])).toBe('RAZ-QA')
  })

  it('returns RAZ-QA for coverage label', () => {
    expect(roleFromLabels(['coverage'])).toBe('RAZ-QA')
  })

  it('returns RAZ-Data for database label', () => {
    expect(roleFromLabels(['database'])).toBe('RAZ-Data')
  })

  it('returns RAZ-Data for migration label', () => {
    expect(roleFromLabels(['migration'])).toBe('RAZ-Data')
  })

  it('returns RAZ-Ops for ops label', () => {
    expect(roleFromLabels(['ops'])).toBe('RAZ-Ops')
  })

  it('returns RAZ-Ops for ci label', () => {
    expect(roleFromLabels(['ci'])).toBe('RAZ-Ops')
  })

  it('returns RAZ-Sec for security label', () => {
    expect(roleFromLabels(['security'])).toBe('RAZ-Sec')
  })

  it('uses first matching rule when multiple labels match different roles', () => {
    // test matches before data — RAZ-QA wins
    expect(roleFromLabels(['test', 'database'])).toBe('RAZ-QA')
  })
})

// ── workflowFromLabels ────────────────────────────────────────────────────────

describe('workflowFromLabels()', () => {
  it('returns feature for no labels', () => {
    expect(workflowFromLabels([])).toBe('feature')
  })

  it('returns fix for bug label', () => {
    expect(workflowFromLabels(['bug'])).toBe('fix')
  })

  it('returns test for testing label', () => {
    expect(workflowFromLabels(['testing'])).toBe('test')
  })

  it('returns strategy for ops label', () => {
    expect(workflowFromLabels(['ops'])).toBe('strategy')
  })

  it('returns audit for security label', () => {
    expect(workflowFromLabels(['security'])).toBe('audit')
  })

  it('returns feature for database label', () => {
    expect(workflowFromLabels(['database'])).toBe('feature')
  })
})

// ── branchForIssue ────────────────────────────────────────────────────────────

describe('branchForIssue()', () => {
  it('produces razdev/issue-{N}-{slug} format', () => {
    expect(branchForIssue(42, 'Fix login bug')).toBe('razdev/issue-42-fix-login-bug')
  })

  it('strips special characters from title', () => {
    expect(branchForIssue(7, 'Handle [auth] tokens & more!')).toMatch(/^razdev\/issue-7-handle-auth-tokens/)
  })

  it('truncates very long titles to 40 chars in the slug', () => {
    const branch = branchForIssue(1, 'A'.repeat(100))
    const slug = branch.replace('razdev/issue-1-', '')
    expect(slug.length).toBeLessThanOrEqual(40)
  })

  it('does not end the slug with a hyphen', () => {
    const branch = branchForIssue(3, 'trailing spaces   ')
    expect(branch).not.toMatch(/-$/)
  })
})

// ── syncAndQueueIssues ────────────────────────────────────────────────────────

describe('syncAndQueueIssues()', () => {
  let repo: RepoRow

  beforeEach(() => {
    cleanDb()
    repo = makeRepo()
    vi.mocked(syncIssues).mockResolvedValue([]) // default: GitHub returns nothing new
  })

  it('queues a task for each new open issue', async () => {
    seedIssue(repo.id, 1, 'Fix login bug', ['bug'])
    seedIssue(repo.id, 2, 'Add dark mode', ['enhancement'])

    const result = await syncAndQueueIssues(repo)

    expect(result.queued).toBe(2)
    expect(result.skipped).toBe(0)
    expect(result.issues).toHaveLength(2)
    // listIssues returns ORDER BY number DESC so higher issue number comes first
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ number: 1, status: 'queued' }),
        expect.objectContaining({ number: 2, status: 'queued' }),
      ]),
    )
  })

  it('skips issues that already have a queued task', async () => {
    seedIssue(repo.id, 1, 'Fix login bug', ['bug'])
    // Manually create a task for issue 1
    createQueuedTask('existing-task', repo.id, 'Fix issue #1', 'razdev/issue-1-fix', 'fix', 'RAZ-Dev')
    setTaskIssueNumber('existing-task', 1)

    const result = await syncAndQueueIssues(repo)

    expect(result.queued).toBe(0)
    expect(result.skipped).toBe(1)
    expect(result.issues[0]).toMatchObject({ number: 1, status: 'skipped' })
  })

  it('skips issues that already have a completed task', async () => {
    seedIssue(repo.id, 5, 'Completed issue', [])
    createQueuedTask('done-task', repo.id, 'Fix issue #5', 'razdev/issue-5-done', 'fix', 'RAZ-Dev')
    setTaskIssueNumber('done-task', 5)
    db.prepare("UPDATE tasks SET status = 'complete' WHERE id = 'done-task'").run()

    const result = await syncAndQueueIssues(repo)

    expect(result.queued).toBe(0)
    expect(result.skipped).toBe(1)
  })

  it('re-queues issues whose only task is failed', async () => {
    seedIssue(repo.id, 3, 'Broken thing', ['bug'])
    createQueuedTask('failed-task', repo.id, 'Fix issue #3', 'razdev/issue-3-old', 'fix', 'RAZ-Dev')
    setTaskIssueNumber('failed-task', 3)
    db.prepare("UPDATE tasks SET status = 'failed' WHERE id = 'failed-task'").run()

    const result = await syncAndQueueIssues(repo)

    expect(result.queued).toBe(1)
    expect(result.skipped).toBe(0)
  })

  it('assigns correct role based on labels', async () => {
    seedIssue(repo.id, 10, 'Write more tests', ['testing'])
    await syncAndQueueIssues(repo)

    const task = getTaskForIssue(repo.id, 10)
    expect(task).not.toBeNull()
    expect(task!.role).toBe('RAZ-QA')
    expect(task!.workflow).toBe('test')
  })

  it('syncs remote issues into DB before processing', async () => {
    vi.mocked(syncIssues).mockResolvedValue([
      { number: 99, title: 'Remote issue', body: null, state: 'open', labels: [], assignee: null },
    ])

    const result = await syncAndQueueIssues(repo)

    expect(vi.mocked(syncIssues)).toHaveBeenCalledWith('owner', 'repo')
    const stored = listIssues(repo.id, 'open')
    expect(stored.some((i) => i.number === 99)).toBe(true)
    expect(result.queued).toBe(1)
  })

  it('sets issue_number on the created task for future dedup', async () => {
    seedIssue(repo.id, 7, 'Dedup test', [])
    await syncAndQueueIssues(repo)

    const task = getTaskForIssue(repo.id, 7)
    expect(task).not.toBeNull()
    expect(task!.issue_number).toBe(7)
  })
})
