import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type * as DbModule from '../db'

// ── Module mocks ──────────────────────────────────────────────────────────────
// Declared before any imports so Vitest can hoist them via vi.mock().

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof DbModule>()
  return {
    ...actual,
    getConfig:           vi.fn(),
    getNextQueuedTask:   vi.fn(),
    getRepoById:         vi.fn(),
    getTask:             vi.fn(),
    listRepos:           vi.fn(),
    resetTaskToRunning:  vi.fn(),
    completeTask:        vi.fn(),
    failTask:            vi.fn(),
    saveTaskLog:         vi.fn(),
    activateHandoffs:    vi.fn(),
    hasRunningDuplicate: vi.fn(),
    hasRecentCompletion: vi.fn(),
    createQueuedTask:    vi.fn(),
  }
})

vi.mock('../github', () => ({
  getPRStatus:         vi.fn(),
  mergePR:             vi.fn().mockResolvedValue(undefined),
  pushBranchAndOpenPR: vi.fn(),
}))

vi.mock('../agent', () => ({
  runAgent:             vi.fn(),
  getActiveAgentRunner: vi.fn(() => 'sdk'),
  normalizeAgentRunner: vi.fn(() => null),
}))

vi.mock('../health-scan', () => ({
  seedHealthTasks:      vi.fn().mockResolvedValue(0),
  HEALTH_SCAN_INTERVAL: 0,   // disable cooldown so seeding fires on every empty-queue tick
}))

vi.mock('../memory-tasks', () => ({
  seedMemoryTasks: vi.fn().mockResolvedValue(0),
}))

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}))

// ── Imports ───────────────────────────────────────────────────────────────────

import { startQueueRunner } from '../queue-runner'
import {
  getConfig, getNextQueuedTask, getRepoById, getTask, listRepos,
  resetTaskToRunning, completeTask, failTask, saveTaskLog, activateHandoffs,
  hasRunningDuplicate, hasRecentCompletion, createQueuedTask,
} from '../db'
import { runAgent } from '../agent'
import { pushBranchAndOpenPR, mergePR, getPRStatus } from '../github'
import { seedHealthTasks } from '../health-scan'
import { seedMemoryTasks } from '../memory-tasks'
import { execSync } from 'child_process'
import type { TaskRow, RepoRow } from '../db'
import type { AgentEvent } from '../agent'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const REPO: RepoRow = {
  id:             1,
  github_owner:   'owner',
  github_repo:    'repo',
  local_path:     '/tmp/repo',
  default_branch: 'master',
}

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id:             'task-1',
    repo_id:        1,
    description:    'Build feature X',
    branch:         'raz-dev/feature-x',
    status:         'queued',
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

function makeParentTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return makeTask({
    id:             'parent-task',
    role:           'RAZ-Dev',
    workflow:       'feature',
    pr_url:         'https://github.com/owner/repo/pull/42',
    parent_task_id: null,
    ...overrides,
  })
}

function makePRStatus(overrides: Partial<{
  merged: boolean; state: string; approvals: number
  rejections: number; ciStatus: string; failingChecks: string[]
}> = {}) {
  return {
    prNumber: 42, state: 'open', merged: false, title: 'Feature X',
    reviewDecision: 'none', approvals: 0, rejections: 0,
    ciStatus: 'passing' as const, failingChecks: [] as string[],
    checkCount: 1, url: 'https://github.com/owner/repo/pull/42',
    ...overrides,
  }
}

// ── startQueueRunner() ────────────────────────────────────────────────────────
//
// Each test uses vi.resetModules() + a fresh dynamic import so it gets its own
// module instance with started=false.  This keeps these tests independent of
// the processQueue describe block (which relies on the statically-imported
// startQueueRunner having started=false when its beforeAll runs).

describe('startQueueRunner()', () => {
  it('creates a 5 s setInterval on the first call', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const spy = vi.spyOn(global, 'setInterval')
    const { startQueueRunner: fn } = await import('../queue-runner')
    fn()
    expect(spy).toHaveBeenCalledOnce()
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 5_000)
    vi.useRealTimers()
    spy.mockRestore()
  })

  it('is idempotent — a second call does not register another interval', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const spy = vi.spyOn(global, 'setInterval')
    const { startQueueRunner: fn } = await import('../queue-runner')
    fn()  // first call — registers interval
    fn()  // second call — early-return, no new interval
    expect(spy).toHaveBeenCalledOnce()
    vi.useRealTimers()
    spy.mockRestore()
  })
})

// ── processQueue() — via the 5 s interval ────────────────────────────────────
//
// The static startQueueRunner (original module, started=false) is called once
// in beforeAll.  Each test advances fake time by 5 000 ms to fire one tick of
// processQueue.

describe('processQueue()', () => {
  beforeAll(() => {
    vi.useFakeTimers()
    startQueueRunner()
  })

  afterAll(() => {
    vi.useRealTimers()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    // Default: 'auto' mode, not paused, empty queue, valid repo, no duplicates
    vi.mocked(getConfig).mockImplementation((key: string) => {
      if (key === 'raz_mode') return 'auto'
      return null
    })
    vi.mocked(getNextQueuedTask).mockReturnValue(null)
    vi.mocked(listRepos).mockReturnValue([])
    vi.mocked(getRepoById).mockReturnValue(REPO)
    vi.mocked(getTask).mockReturnValue(null)
    vi.mocked(hasRunningDuplicate).mockReturnValue(false)
    vi.mocked(hasRecentCompletion).mockReturnValue(false)
    vi.mocked(mergePR).mockResolvedValue(undefined)
    vi.mocked(pushBranchAndOpenPR).mockResolvedValue('https://github.com/owner/repo/pull/99')
    // Default execSync return: '' → git fetch ignored; rev-list parseInt('',10)||0 = 0 commits
    vi.mocked(execSync).mockReturnValue('' as unknown as ReturnType<typeof execSync>)
  })

  // ── Mode and pause guards ─────────────────────────────────────────────────

  describe('mode and pause guards', () => {
    it('skips when raz_mode is "standard"', async () => {
      vi.mocked(getConfig).mockReturnValue('standard')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(getNextQueuedTask).not.toHaveBeenCalled()
    })

    it('skips when raz_mode is null (defaults to "standard")', async () => {
      vi.mocked(getConfig).mockReturnValue(null)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(getNextQueuedTask).not.toHaveBeenCalled()
    })

    it('skips when task_paused is "1"', async () => {
      vi.mocked(getConfig).mockImplementation((key: string) => {
        if (key === 'raz_mode')    return 'auto'
        if (key === 'task_paused') return '1'
        return null
      })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(getNextQueuedTask).not.toHaveBeenCalled()
    })

    it('proceeds to poll the queue when mode is "auto" and not paused', async () => {
      await vi.advanceTimersByTimeAsync(5_000)
      expect(getNextQueuedTask).toHaveBeenCalled()
    })
  })

  // ── Empty queue — health / memory seeding ─────────────────────────────────

  describe('empty queue', () => {
    it('calls seedHealthTasks for repos that have a local_path', async () => {
      vi.mocked(listRepos).mockReturnValue([REPO])
      await vi.advanceTimersByTimeAsync(5_000)
      expect(seedHealthTasks).toHaveBeenCalledWith(REPO)
    })

    it('calls seedMemoryTasks for every repo (with or without local_path)', async () => {
      vi.mocked(listRepos).mockReturnValue([REPO])
      await vi.advanceTimersByTimeAsync(5_000)
      expect(seedMemoryTasks).toHaveBeenCalledWith(REPO)
    })

    it('does not call seedHealthTasks for repos without local_path', async () => {
      vi.mocked(listRepos).mockReturnValue([{ ...REPO, local_path: null }])
      await vi.advanceTimersByTimeAsync(5_000)
      expect(seedHealthTasks).not.toHaveBeenCalled()
    })
  })

  // ── Dedup guards ──────────────────────────────────────────────────────────

  describe('dedup guards', () => {
    it('fails the task when an identical task is already running', async () => {
      vi.mocked(getNextQueuedTask).mockReturnValue(makeTask())
      vi.mocked(hasRunningDuplicate).mockReturnValue(true)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(failTask).toHaveBeenCalledWith('task-1', 'Skipped — identical task already running')
      expect(runAgent).not.toHaveBeenCalled()
    })

    it('fails the task when an identical task completed recently', async () => {
      vi.mocked(getNextQueuedTask).mockReturnValue(makeTask())
      vi.mocked(hasRecentCompletion).mockReturnValue(true)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(failTask).toHaveBeenCalledWith(
        'task-1', 'Skipped — identical task completed within the last 15 minutes',
      )
      expect(runAgent).not.toHaveBeenCalled()
    })

    it('silently skips when the repo cannot be found', async () => {
      vi.mocked(getNextQueuedTask).mockReturnValue(makeTask())
      vi.mocked(getRepoById).mockReturnValue(null)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(runAgent).not.toHaveBeenCalled()
      expect(failTask).not.toHaveBeenCalled()
    })

    it('silently skips when the repo has no local_path', async () => {
      vi.mocked(getNextQueuedTask).mockReturnValue(makeTask())
      vi.mocked(getRepoById).mockReturnValue({ ...REPO, local_path: null })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(runAgent).not.toHaveBeenCalled()
      expect(failTask).not.toHaveBeenCalled()
    })
  })

  // ── ci_wait workflow ──────────────────────────────────────────────────────

  describe('ci_wait workflow', () => {
    const CI_TASK: TaskRow = makeTask({
      id:             'ci-wait-1',
      workflow:       'ci_wait',
      role:           'RAZ-Ops',
      description:    'CI wait #1: PR #42 — Build feature X',
      parent_task_id: 'parent-task',
    })

    beforeEach(() => {
      vi.mocked(getNextQueuedTask).mockReturnValue(CI_TASK)
      vi.mocked(getTask).mockReturnValue(makeParentTask())
      vi.mocked(getPRStatus).mockResolvedValue(makePRStatus())
    })

    it('marks task running, runs the CI gate, then completes', async () => {
      await vi.advanceTimersByTimeAsync(5_000)
      expect(resetTaskToRunning).toHaveBeenCalledWith('ci-wait-1')
      expect(getPRStatus).toHaveBeenCalled()
      expect(completeTask).toHaveBeenCalledWith(
        'ci-wait-1', null, expect.stringContaining('CI gate check'), [],
      )
      expect(runAgent).not.toHaveBeenCalled()
    })

    it('fails with a CI gate error message when handleCIGate throws', async () => {
      vi.mocked(getPRStatus).mockRejectedValue(new Error('network timeout'))
      await vi.advanceTimersByTimeAsync(5_000)
      expect(failTask).toHaveBeenCalledWith(
        'ci-wait-1', expect.stringContaining('CI gate error'),
      )
      expect(completeTask).not.toHaveBeenCalled()
    })

    it('completes without calling handleCIGate when parent has no PR URL', async () => {
      vi.mocked(getTask).mockReturnValue(makeParentTask({ pr_url: null }))
      await vi.advanceTimersByTimeAsync(5_000)
      expect(getPRStatus).not.toHaveBeenCalled()
      expect(completeTask).toHaveBeenCalledWith('ci-wait-1', null, expect.any(String), [])
    })
  })

  // ── Regular agent task ────────────────────────────────────────────────────

  describe('regular agent task', () => {
    beforeEach(() => {
      vi.mocked(getNextQueuedTask).mockReturnValue(makeTask())
    })

    it('marks the task running and passes correct params to runAgent', async () => {
      vi.mocked(runAgent).mockResolvedValue(undefined)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(resetTaskToRunning).toHaveBeenCalledWith('task-1')
      expect(runAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId:      'task-1',
          repoPath:    '/tmp/repo',
          description: 'Build feature X',
          branch:      'raz-dev/feature-x',
          workflow:    'feature',
          role:        'RAZ-Dev',
        }),
        expect.any(Function),
      )
    })

    it('fails and queues a RAZ-Ops strategy when agent never emits complete', async () => {
      vi.mocked(runAgent).mockResolvedValue(undefined)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(failTask).toHaveBeenCalledWith('task-1', 'Agent did not reach task_complete')
      const [call] = vi.mocked(createQueuedTask).mock.calls
      expect(call?.[4]).toBe('strategy')
      expect(call?.[5]).toBe('RAZ-Ops')
    })

    it('completes with null pr_url when 0 commits are ahead of origin', async () => {
      vi.mocked(runAgent).mockImplementation(async (_task, onEvent) => {
        onEvent({ type: 'complete', message: 'done', data: { files_changed: [] } })
      })
      // Default execSync returns '' → rev-list = '' → parseInt('',10)||0 = 0
      await vi.advanceTimersByTimeAsync(5_000)
      expect(completeTask).toHaveBeenCalledWith('task-1', null, 'done', [])
      expect(pushBranchAndOpenPR).not.toHaveBeenCalled()
      expect(activateHandoffs).toHaveBeenCalledWith('task-1')
    })

    it('pushes a PR and queues a RAZ-QA review when commits are ahead', async () => {
      vi.mocked(runAgent).mockImplementation(async (_task, onEvent) => {
        onEvent({ type: 'complete', message: 'done', data: { files_changed: ['lib/foo.ts'] } })
      })
      // First execSync call = git fetch (ignored); second = rev-list returning '2' → 2 ahead
      vi.mocked(execSync)
        .mockReturnValueOnce(undefined as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce('2' as unknown as ReturnType<typeof execSync>)
      vi.mocked(pushBranchAndOpenPR).mockResolvedValue('https://github.com/owner/repo/pull/99')

      await vi.advanceTimersByTimeAsync(5_000)

      expect(pushBranchAndOpenPR).toHaveBeenCalled()
      expect(completeTask).toHaveBeenCalledWith(
        'task-1', 'https://github.com/owner/repo/pull/99', 'done', ['lib/foo.ts'],
      )
      const reviewCall = vi.mocked(createQueuedTask).mock.calls.find((c) => c[4] === 'review')
      expect(reviewCall).toBeDefined()
      expect(reviewCall?.[5]).toBe('RAZ-QA')
      expect(reviewCall?.[2]).toContain('Pre-merge review: PR #99')
    })

    it('completes with null pr_url and activates handoffs when commit_skipped', async () => {
      vi.mocked(runAgent).mockImplementation(async (_task, onEvent) => {
        onEvent({
          type:    'complete',
          message: 'nothing to commit',
          data:    { commit_skipped: true, files_changed: [] },
        })
      })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(completeTask).toHaveBeenCalledWith('task-1', null, 'nothing to commit', [])
      expect(pushBranchAndOpenPR).not.toHaveBeenCalled()
      expect(activateHandoffs).toHaveBeenCalledWith('task-1')
    })

    it('fails and queues a RAZ-Ops strategy when runAgent throws', async () => {
      vi.mocked(runAgent).mockRejectedValue(new Error('subprocess crash'))
      await vi.advanceTimersByTimeAsync(5_000)
      expect(failTask).toHaveBeenCalledWith(
        'task-1', expect.stringContaining('subprocess crash'),
      )
      const [call] = vi.mocked(createQueuedTask).mock.calls
      expect(call?.[4]).toBe('strategy')
      expect(call?.[5]).toBe('RAZ-Ops')
    })

    it('saves the task log after runAgent resolves', async () => {
      vi.mocked(runAgent).mockResolvedValue(undefined)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(saveTaskLog).toHaveBeenCalledWith('task-1', expect.any(Array))
    })

    it('excludes tool_result events from the log buffer', async () => {
      const captured: unknown[][] = []
      vi.mocked(saveTaskLog).mockImplementation((_id, buf) => { captured.push(buf as unknown[]) })
      vi.mocked(runAgent).mockImplementation(async (_task, onEvent) => {
        onEvent({ type: 'tool_result', message: 'internal output', data: {} })
        onEvent({ type: 'usage',       message: '50 tokens used', data: {} })
      })
      await vi.advanceTimersByTimeAsync(5_000)
      const lastBuffer = (captured.at(-1) ?? []) as AgentEvent[]
      expect(lastBuffer.map((e) => e.type)).not.toContain('tool_result')
      expect(lastBuffer.map((e) => e.type)).toContain('usage')
    })
  })
})
