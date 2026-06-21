import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.hoisted(() => {
  process.env['RAZ_DB_PATH'] = ':memory:'
})

import db, { upsertRepo, getTaskForIssue } from '@/lib/db'
import {
  verifyGitHubSignature, handleGitHubWebhook, type GitHubPayload,
} from '../webhook-handler'
import type { RepoRow, TaskRow } from '../db'

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

function basePayload(overrides: Partial<GitHubPayload> = {}): GitHubPayload {
  return {
    repository: { owner: { login: 'owner' }, name: 'repo', default_branch: 'master' },
    ...overrides,
  }
}

// ── verifyGitHubSignature ─────────────────────────────────────────────────────

describe('verifyGitHubSignature()', () => {
  it('returns true for a valid HMAC-SHA256 signature', () => {
    const { createHmac } = require('crypto') as typeof import('crypto')
    const secret = 'test-secret'
    const body   = '{"action":"opened"}'
    const sig    = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    expect(verifyGitHubSignature(secret, body, sig)).toBe(true)
  })

  it('returns false for wrong secret', () => {
    const { createHmac } = require('crypto') as typeof import('crypto')
    const body = '{"action":"opened"}'
    const sig  = `sha256=${createHmac('sha256', 'wrong').update(body).digest('hex')}`
    expect(verifyGitHubSignature('correct-secret', body, sig)).toBe(false)
  })

  it('returns false when signature header is missing sha256= prefix', () => {
    expect(verifyGitHubSignature('secret', 'body', 'deadbeef')).toBe(false)
  })

  it('returns false for empty signature', () => {
    expect(verifyGitHubSignature('secret', 'body', '')).toBe(false)
  })
})

// ── handleGitHubWebhook — repo lookup ─────────────────────────────────────────

describe('handleGitHubWebhook() — repo lookup', () => {
  beforeEach(cleanDb)

  it('returns skipped when repo is not registered', async () => {
    const result = await handleGitHubWebhook('issues', basePayload({ action: 'opened' }))
    expect(result.action).toBe('skipped')
    expect(result.description).toContain('not registered')
  })

  it('returns error when repository info is missing', async () => {
    const result = await handleGitHubWebhook('issues', {} as GitHubPayload)
    expect(result.action).toBe('error')
  })

  it('returns skipped for unhandled event types', async () => {
    makeRepo()
    const result = await handleGitHubWebhook('create', basePayload())
    expect(result.action).toBe('skipped')
    expect(result.description).toContain('Unhandled event')
  })
})

// ── issues event ──────────────────────────────────────────────────────────────

describe('handleGitHubWebhook() — issues', () => {
  beforeEach(cleanDb)

  it('queues a task when an issue is opened', async () => {
    makeRepo()
    const result = await handleGitHubWebhook('issues', basePayload({
      action: 'opened',
      issue:  { number: 42, title: 'Login fails on mobile', body: null, state: 'open', labels: [{ name: 'bug' }], assignee: null },
    }))
    expect(result.action).toBe('queued')
    expect(result.taskId).toBeDefined()
  })

  it('assigns correct role from labels', async () => {
    const repo = makeRepo()
    await handleGitHubWebhook('issues', basePayload({
      action: 'opened',
      issue:  { number: 5, title: 'Add tests for auth', body: null, state: 'open', labels: [{ name: 'testing' }], assignee: null },
    }))
    const task = getTaskForIssue(repo.id, 5)
    expect(task!.role).toBe('RAZ-QA')
    expect(task!.workflow).toBe('test')
  })

  it('skips if an active task already exists for the issue', async () => {
    const repo = makeRepo()
    await handleGitHubWebhook('issues', basePayload({
      action: 'opened',
      issue:  { number: 7, title: 'Duplicate issue', body: null, state: 'open', labels: [], assignee: null },
    }))
    // Fire again — should be skipped
    const result = await handleGitHubWebhook('issues', basePayload({
      action: 'opened',
      issue:  { number: 7, title: 'Duplicate issue', body: null, state: 'open', labels: [], assignee: null },
    }))
    expect(result.action).toBe('skipped')
    expect(result.description).toContain('already has task')
  })

  it('skips non-opened/reopened issue actions', async () => {
    makeRepo()
    const result = await handleGitHubWebhook('issues', basePayload({
      action: 'labeled',
      issue:  { number: 1, title: 'Something', body: null, state: 'open', labels: [], assignee: null },
    }))
    expect(result.action).toBe('skipped')
  })
})

// ── pull_request event ────────────────────────────────────────────────────────

describe('handleGitHubWebhook() — pull_request', () => {
  beforeEach(cleanDb)

  it('queues a RAZ-QA review task when PR is opened', async () => {
    makeRepo()
    const result = await handleGitHubWebhook('pull_request', basePayload({
      action:       'opened',
      pull_request: { number: 10, title: 'Add feature X', merged: false, html_url: 'https://github.com/owner/repo/pull/10' },
    }))
    expect(result.action).toBe('queued')
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(result.taskId) as TaskRow
    expect(task.role).toBe('RAZ-QA')
    expect(task.workflow).toBe('review')
  })

  it('queues a RAZ-QA audit task when PR is merged', async () => {
    makeRepo()
    const result = await handleGitHubWebhook('pull_request', basePayload({
      action:       'closed',
      pull_request: { number: 11, title: 'Merged feature', merged: true, html_url: 'https://github.com/owner/repo/pull/11' },
    }))
    expect(result.action).toBe('queued')
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(result.taskId) as TaskRow
    expect(task.role).toBe('RAZ-QA')
    expect(task.workflow).toBe('audit')
  })

  it('skips when PR is closed but not merged', async () => {
    makeRepo()
    const result = await handleGitHubWebhook('pull_request', basePayload({
      action:       'closed',
      pull_request: { number: 12, title: 'Abandoned PR', merged: false, html_url: '' },
    }))
    expect(result.action).toBe('skipped')
  })

  it('skips synchronize and other PR actions', async () => {
    makeRepo()
    const result = await handleGitHubWebhook('pull_request', basePayload({
      action:       'synchronize',
      pull_request: { number: 10, title: 'Add feature X', merged: false, html_url: '' },
    }))
    expect(result.action).toBe('skipped')
  })
})

// ── pull_request_review event ─────────────────────────────────────────────────

describe('handleGitHubWebhook() — pull_request_review', () => {
  beforeEach(cleanDb)

  it('queues a HIGH priority RAZ-Dev fix when human requests changes', async () => {
    makeRepo()
    const result = await handleGitHubWebhook('pull_request_review', basePayload({
      action:       'submitted',
      pull_request: { number: 20, title: 'My PR', merged: false, html_url: '' },
      review:       { state: 'changes_requested', body: 'Please add error handling' },
    }))
    expect(result.action).toBe('queued')
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(result.taskId) as TaskRow
    expect(task.role).toBe('RAZ-Dev')
    expect(task.workflow).toBe('fix')
    expect(task.priority).toBe(2) // PRIORITY.HIGH
    expect(task.description).toContain('Please add error handling')
  })

  it('skips approved reviews', async () => {
    makeRepo()
    const result = await handleGitHubWebhook('pull_request_review', basePayload({
      action:       'submitted',
      pull_request: { number: 20, title: 'My PR', merged: false, html_url: '' },
      review:       { state: 'approved', body: 'LGTM' },
    }))
    expect(result.action).toBe('skipped')
  })
})

// ── push event ────────────────────────────────────────────────────────────────

describe('handleGitHubWebhook() — push', () => {
  beforeEach(cleanDb)

  it('queues a RAZ-Ops health scan on push to default branch', async () => {
    makeRepo()
    const result = await handleGitHubWebhook('push', basePayload({ ref: 'refs/heads/master' }))
    expect(result.action).toBe('queued')
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(result.taskId) as TaskRow
    expect(task.role).toBe('RAZ-Ops')
    expect(task.workflow).toBe('strategy')
  })

  it('skips push to non-default branch', async () => {
    makeRepo()
    const result = await handleGitHubWebhook('push', basePayload({ ref: 'refs/heads/feature-x' }))
    expect(result.action).toBe('skipped')
  })

  it('deduplicates rapid pushes', async () => {
    makeRepo()
    await handleGitHubWebhook('push', basePayload({ ref: 'refs/heads/master' }))
    // Complete the task so hasRecentCompletion fires
    const [task] = db.prepare("SELECT id FROM tasks").all() as { id: string }[]
    db.prepare("UPDATE tasks SET status = 'complete', completed_at = datetime('now') WHERE id = ?").run(task!.id)
    const result2 = await handleGitHubWebhook('push', basePayload({ ref: 'refs/heads/master' }))
    expect(result2.action).toBe('skipped')
  })
})
