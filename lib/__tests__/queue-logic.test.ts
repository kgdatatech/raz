import { vi, describe, it, expect, beforeEach } from 'vitest'

// Mock db and github BEFORE queue-runner is imported so the gate handlers
// use the mocked versions, not the real SQLite / Octokit calls.
vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>()
  return {
    ...actual,
    getTask:          vi.fn(),
    createQueuedTask: vi.fn(),
    activateHandoffs: vi.fn(),
    completeTask:     vi.fn(),
    failTask:         vi.fn(),
  }
})

vi.mock('../github', () => ({
  getPRStatus:      vi.fn(),
  mergePR:          vi.fn(),
  pushBranchAndOpenPR: vi.fn(),
}))

vi.mock('child_process', () => ({ execSync: vi.fn() }))

import { parseCIWaitRetry, handleReviewGate, handleCIGate } from '../queue-runner'
import { getTask, createQueuedTask, activateHandoffs } from '../db'
import { getPRStatus, mergePR } from '../github'
import type { TaskRow, RepoRow } from '../db'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const REPO: RepoRow = {
  id:            1,
  github_owner:  'owner',
  github_repo:   'repo',
  local_path:    '/tmp/repo',
  default_branch: 'master',
}

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id:             'task-id',
    repo_id:        1,
    description:    'Build feature X',
    branch:         'raz-dev/feature-x',
    status:         'running',
    workflow:       'review',
    role:           'RAZ-QA',
    issue_number:   null,
    plan:           null,
    pr_url:         null,
    summary:        null,
    error:          null,
    files_changed:  null,
    parent_task_id: 'dev-task-id',
    created_at:     new Date().toISOString(),
    completed_at:   null,
    priority:       1,
    runner:         'sdk',
    ...overrides,
  } as TaskRow
}

function makeParentTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return makeTask({
    id:             'dev-task-id',
    role:           'RAZ-Dev',
    workflow:       'feature',
    pr_url:         'https://github.com/owner/repo/pull/42',
    parent_task_id: null,
    summary:        'Added feature X',
    ...overrides,
  })
}

function makeCIWaitTask(retry = 1): TaskRow {
  return makeTask({
    id:       `ci-wait-${retry}`,
    workflow: 'ci_wait',
    role:     'RAZ-Ops',
    description: `CI wait #${retry}: PR #42 — Build feature X`,
    parent_task_id: 'dev-task-id',
  })
}

function makePRStatus(overrides: Partial<ReturnType<typeof defaultPRStatus>> = {}) {
  return { ...defaultPRStatus(), ...overrides }
}

function defaultPRStatus() {
  return {
    prNumber:       42,
    state:          'open',
    merged:         false,
    title:          'Feature X',
    reviewDecision: 'none',
    approvals:      0,
    rejections:     0,
    ciStatus:       'passing' as const,
    failingChecks:  [] as string[],
    checkCount:     1,
    url:            'https://github.com/owner/repo/pull/42',
  }
}

// ── parseCIWaitRetry ──────────────────────────────────────────────────────────

describe('parseCIWaitRetry()', () => {
  it('parses retry 1', () => {
    expect(parseCIWaitRetry('CI wait #1: PR #42 — Build feature X')).toBe(1)
  })

  it('parses higher retry numbers', () => {
    expect(parseCIWaitRetry('CI wait #42: PR #8 — something')).toBe(42)
  })

  it('parses max-range retries', () => {
    expect(parseCIWaitRetry('CI wait #90: PR #1 — last attempt')).toBe(90)
  })

  it('returns 1 for unrecognised descriptions', () => {
    expect(parseCIWaitRetry('Post-merge audit: PR #42')).toBe(1)
    expect(parseCIWaitRetry('')).toBe(1)
  })
})

// ── handleReviewGate ──────────────────────────────────────────────────────────

describe('handleReviewGate()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getTask).mockReturnValue(makeParentTask())
  })

  it('does nothing when workflow is not review', async () => {
    const task = makeTask({ workflow: 'feature' })
    await handleReviewGate(task, REPO)
    expect(getPRStatus).not.toHaveBeenCalled()
  })

  it('does nothing when parent_task_id is missing', async () => {
    const task = makeTask({ parent_task_id: null })
    await handleReviewGate(task, REPO)
    expect(getPRStatus).not.toHaveBeenCalled()
  })

  it('does nothing when parent has no pr_url', async () => {
    vi.mocked(getTask).mockReturnValue(makeParentTask({ pr_url: null }))
    await handleReviewGate(makeTask(), REPO)
    expect(getPRStatus).not.toHaveBeenCalled()
  })

  it('activates handoffs and skips merge when PR is already merged', async () => {
    vi.mocked(getPRStatus).mockResolvedValue(makePRStatus({ merged: true }))
    await handleReviewGate(makeTask(), REPO)
    expect(activateHandoffs).toHaveBeenCalledWith('dev-task-id')
    expect(mergePR).not.toHaveBeenCalled()
  })

  it('merges and queues post-merge audit when approved + CI passing', async () => {
    vi.mocked(getPRStatus).mockResolvedValue(makePRStatus({ approvals: 1, ciStatus: 'passing' }))
    await handleReviewGate(makeTask(), REPO)
    expect(mergePR).toHaveBeenCalledWith('owner', 'repo', 42)
    expect(activateHandoffs).toHaveBeenCalledWith('dev-task-id')
    const auditCall = vi.mocked(createQueuedTask).mock.calls[0]
    expect(auditCall?.[4]).toBe('audit')
    expect(auditCall?.[5]).toBe('RAZ-QA')
  })

  it('merges when approved + CI no_checks (no CI configured)', async () => {
    vi.mocked(getPRStatus).mockResolvedValue(makePRStatus({ approvals: 1, ciStatus: 'no_checks' }))
    await handleReviewGate(makeTask(), REPO)
    expect(mergePR).toHaveBeenCalledWith('owner', 'repo', 42)
  })

  it('queues ci_wait when approved but CI is still pending', async () => {
    vi.mocked(getPRStatus).mockResolvedValue(makePRStatus({ approvals: 1, ciStatus: 'pending' }))
    await handleReviewGate(makeTask(), REPO)
    expect(mergePR).not.toHaveBeenCalled()
    const waitCall = vi.mocked(createQueuedTask).mock.calls[0]
    expect(waitCall?.[4]).toBe('ci_wait')
    expect(waitCall?.[5]).toBe('RAZ-Ops')
    expect(waitCall?.[2]).toContain('CI wait #1')
  })

  it('queues RAZ-Dev fix when approved but CI is failing', async () => {
    vi.mocked(getPRStatus).mockResolvedValue(
      makePRStatus({ approvals: 1, ciStatus: 'failing', failingChecks: ['lint: failure'] }),
    )
    await handleReviewGate(makeTask(), REPO)
    expect(mergePR).not.toHaveBeenCalled()
    const fixCall = vi.mocked(createQueuedTask).mock.calls[0]
    expect(fixCall?.[4]).toBe('fix')
    expect(fixCall?.[5]).toBe('RAZ-Dev')
    expect(fixCall?.[2]).toContain('lint: failure')
  })

  it('queues RAZ-Dev fix with summary when QA requests changes', async () => {
    vi.mocked(getPRStatus).mockResolvedValue(makePRStatus({ approvals: 0, rejections: 1 }))
    const task = makeTask({ summary: 'Missing error handling on line 42' })
    await handleReviewGate(task, REPO)
    expect(mergePR).not.toHaveBeenCalled()
    const fixCall = vi.mocked(createQueuedTask).mock.calls[0]
    expect(fixCall?.[4]).toBe('fix')
    expect(fixCall?.[5]).toBe('RAZ-Dev')
    expect(fixCall?.[2]).toContain('Missing error handling')
  })
})

// ── handleCIGate ──────────────────────────────────────────────────────────────

describe('handleCIGate()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getTask).mockReturnValue(makeParentTask())
  })

  it('merges and queues audit when CI passes', async () => {
    vi.mocked(getPRStatus).mockResolvedValue(makePRStatus({ ciStatus: 'passing' }))
    await handleCIGate(makeCIWaitTask(1), REPO, 42)
    expect(mergePR).toHaveBeenCalledWith('owner', 'repo', 42)
    const auditCall = vi.mocked(createQueuedTask).mock.calls[0]
    expect(auditCall?.[4]).toBe('audit')
  })

  it('merges when CI has no_checks', async () => {
    vi.mocked(getPRStatus).mockResolvedValue(makePRStatus({ ciStatus: 'no_checks' }))
    await handleCIGate(makeCIWaitTask(1), REPO, 42)
    expect(mergePR).toHaveBeenCalledWith('owner', 'repo', 42)
  })

  it('activates handoffs without merging when PR is already merged', async () => {
    vi.mocked(getPRStatus).mockResolvedValue(makePRStatus({ merged: true }))
    await handleCIGate(makeCIWaitTask(1), REPO, 42)
    expect(mergePR).not.toHaveBeenCalled()
    expect(activateHandoffs).toHaveBeenCalledWith('dev-task-id')
  })

  it('re-queues next ci_wait when CI is still pending and under retry limit', async () => {
    vi.mocked(getPRStatus).mockResolvedValue(makePRStatus({ ciStatus: 'pending' }))
    await handleCIGate(makeCIWaitTask(5), REPO, 42)
    expect(mergePR).not.toHaveBeenCalled()
    const waitCall = vi.mocked(createQueuedTask).mock.calls[0]
    expect(waitCall?.[4]).toBe('ci_wait')
    expect(waitCall?.[2]).toContain('CI wait #6')
  })

  it('queues a RAZ-Dev fix when CI is still pending at max retries', async () => {
    vi.mocked(getPRStatus).mockResolvedValue(makePRStatus({ ciStatus: 'pending' }))
    await handleCIGate(makeCIWaitTask(90), REPO, 42)
    expect(mergePR).not.toHaveBeenCalled()
    const fixCall = vi.mocked(createQueuedTask).mock.calls[0]
    expect(fixCall?.[4]).toBe('fix')
    expect(fixCall?.[2]).toContain('timeout')
  })

  it('queues RAZ-Dev fix with check names when CI fails', async () => {
    vi.mocked(getPRStatus).mockResolvedValue(
      makePRStatus({ ciStatus: 'failing', failingChecks: ['typecheck: failure', 'lint: failure'] }),
    )
    await handleCIGate(makeCIWaitTask(1), REPO, 42)
    expect(mergePR).not.toHaveBeenCalled()
    const fixCall = vi.mocked(createQueuedTask).mock.calls[0]
    expect(fixCall?.[4]).toBe('fix')
    expect(fixCall?.[5]).toBe('RAZ-Dev')
    expect(fixCall?.[2]).toContain('typecheck: failure')
  })
})
