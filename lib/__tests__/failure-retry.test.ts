import { vi, describe, it, expect, beforeEach } from 'vitest'

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
  getPRStatus:         vi.fn(),
  mergePR:             vi.fn(),
  pushBranchAndOpenPR: vi.fn(),
}))

vi.mock('child_process', () => ({ execSync: vi.fn() }))

vi.mock('../agent', () => ({
  runAgent:               vi.fn(),
  getActiveAgentRunner:   vi.fn(() => 'claude_code'),
  normalizeAgentRunner:   vi.fn((value: string | null | undefined) => value ?? null),
  isAgentRunnerAvailable: vi.fn((runner: string) => runner === 'claude_code'),
}))

import { shouldQueueFailureStrategy, queueFailureStrategy } from '../queue-runner'
import { createQueuedTask } from '../db'
import type { TaskRow, RepoRow } from '../db'

const REPO: RepoRow = {
  id:             1,
  github_owner:   'owner',
  github_repo:    'repo',
  local_path:     '/tmp/repo',
  default_branch: 'master',
}

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id:             'task-id',
    repo_id:        1,
    description:    'Build feature X',
    branch:         'raz-dev/feature-x',
    status:         'failed',
    workflow:       'feature',
    role:           'RAZ-Dev',
    issue_number:   null,
    plan:           null,
    pr_url:         null,
    summary:        null,
    error:          null,
    files_changed:  null,
    parent_task_id: null,
    created_at:     new Date().toISOString(),
    completed_at:   null,
    priority:       1,
    runner:         'sdk',
    ...overrides,
  } as TaskRow
}

// ── shouldQueueFailureStrategy ────────────────────────────────────────────────

describe('shouldQueueFailureStrategy()', () => {
  it('returns true for agent-run workflows', () => {
    expect(shouldQueueFailureStrategy('feature')).toBe(true)
    expect(shouldQueueFailureStrategy('fix')).toBe(true)
    expect(shouldQueueFailureStrategy('refactor')).toBe(true)
    expect(shouldQueueFailureStrategy('test')).toBe(true)
    expect(shouldQueueFailureStrategy('self')).toBe(true)
  })

  it('returns false for strategy (prevents infinite loop)', () => {
    expect(shouldQueueFailureStrategy('strategy')).toBe(false)
  })

  it('returns false for review and audit (gate workflows)', () => {
    expect(shouldQueueFailureStrategy('review')).toBe(false)
    expect(shouldQueueFailureStrategy('audit')).toBe(false)
  })

  it('returns false for ci_wait (polling workflow)', () => {
    expect(shouldQueueFailureStrategy('ci_wait')).toBe(false)
  })

  it('returns true for null workflow (treated same as feature in the runner)', () => {
    expect(shouldQueueFailureStrategy(null)).toBe(true)
  })
})

// ── queueFailureStrategy ──────────────────────────────────────────────────────

describe('queueFailureStrategy()', () => {
  beforeEach(() => vi.clearAllMocks())

  it('queues a RAZ-Ops strategy task on eligible failure', () => {
    queueFailureStrategy(makeTask({ workflow: 'feature' }), REPO, 'Agent did not reach task_complete')
    expect(createQueuedTask).toHaveBeenCalledOnce()
    const call = vi.mocked(createQueuedTask).mock.calls[0]!
    expect(call[4]).toBe('strategy')
    expect(call[5]).toBe('RAZ-Ops')
    expect(call[2]).toContain('Post-failure strategy')
    expect(call[2]).toContain('Build feature X')
    expect(call[2]).toContain('Agent did not reach task_complete')
    expect(call[6]).toBe('task-id') // parent_task_id links back to failed task
    // The failed task's SDK runner is unavailable, so recovery uses the
    // currently configured available runner instead of repeating the failure.
    expect(call[9]).toBe('claude_code')
  })

  it('sets status to queued', () => {
    queueFailureStrategy(makeTask({ workflow: 'fix' }), REPO, 'Error: timeout')
    const call = vi.mocked(createQueuedTask).mock.calls[0]!
    expect(call[7]).toBe('queued')
  })

  it('does NOT queue anything when workflow is strategy', () => {
    queueFailureStrategy(makeTask({ workflow: 'strategy' }), REPO, 'crash')
    expect(createQueuedTask).not.toHaveBeenCalled()
  })

  it('does NOT queue anything when workflow is review', () => {
    queueFailureStrategy(makeTask({ workflow: 'review' }), REPO, 'no verdict')
    expect(createQueuedTask).not.toHaveBeenCalled()
  })

  it('does NOT queue anything when workflow is audit', () => {
    queueFailureStrategy(makeTask({ workflow: 'audit' }), REPO, 'error')
    expect(createQueuedTask).not.toHaveBeenCalled()
  })

  it('truncates very long descriptions and reasons to stay readable', () => {
    const longDesc   = 'D'.repeat(200)
    const longReason = 'R'.repeat(300)
    queueFailureStrategy(makeTask({ workflow: 'feature', description: longDesc }), REPO, longReason)
    const call = vi.mocked(createQueuedTask).mock.calls[0]!
    // description is capped at 80 chars, reason at 120 chars
    expect(call[2].length).toBeLessThan(250)
  })

  it('links strategy task branch name with razops/ prefix', () => {
    queueFailureStrategy(makeTask({ workflow: 'feature' }), REPO, 'oops')
    const call = vi.mocked(createQueuedTask).mock.calls[0]!
    expect(call[3]).toMatch(/^razops\/strategy-/)
  })
})
