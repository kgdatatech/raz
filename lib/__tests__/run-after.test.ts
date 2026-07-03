import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.hoisted(() => {
  process.env['RAZ_DB_PATH'] = ':memory:'
})

import db, {
  upsertRepo, createQueuedTask, claimNextQueuedTask, getNextQueuedTask,
  requeueTaskForRetry, getTask,
} from '@/lib/db'

function cleanDb() {
  db.prepare('DELETE FROM memory').run()
  db.prepare('DELETE FROM chat_messages').run()
  db.prepare('DELETE FROM tasks').run()
  db.prepare('DELETE FROM repos').run()
}

describe('run_after scheduling', () => {
  let repoId: number

  beforeEach(() => {
    cleanDb()
    repoId = upsertRepo('o', 'r', 'main').id
  })

  it('createQueuedTask without runAfterSeconds is claimable immediately', () => {
    createQueuedTask('t1', repoId, 'Task A', 'branch-a')
    expect(claimNextQueuedTask('w1')?.id).toBe('t1')
  })

  it('createQueuedTask with runAfterSeconds sets a future run_after', () => {
    const task = createQueuedTask('t1', repoId, 'Task A', 'branch-a', 'ci_wait', 'RAZ-Ops', undefined, 'queued', 1, null, 300)
    expect(task.run_after).toBeTruthy()
  })

  it('claimNextQueuedTask skips tasks whose run_after is in the future', () => {
    createQueuedTask('delayed', repoId, 'Delayed', 'branch-d', 'ci_wait', 'RAZ-Ops', undefined, 'queued', 1, null, 300)
    expect(claimNextQueuedTask('w1')).toBeNull()
    expect(getNextQueuedTask()).toBeNull()
  })

  it('claims a delayed task once its run_after has passed', () => {
    createQueuedTask('delayed', repoId, 'Delayed', 'branch-d', 'ci_wait', 'RAZ-Ops', undefined, 'queued', 1, null, 300)
    db.prepare(`UPDATE tasks SET run_after = datetime('now', '-1 second') WHERE id = 'delayed'`).run()
    expect(claimNextQueuedTask('w1')?.id).toBe('delayed')
  })

  it('a due delayed task does not block an immediate task of equal priority ordering', () => {
    createQueuedTask('delayed', repoId, 'Delayed', 'branch-d', 'ci_wait', 'RAZ-Ops', undefined, 'queued', 1, null, 300)
    createQueuedTask('now', repoId, 'Immediate', 'branch-n')
    expect(claimNextQueuedTask('w1')?.id).toBe('now')
  })

  it('requeueTaskForRetry puts a running task back in the queue with a delay', () => {
    createQueuedTask('t1', repoId, 'CI wait #1: PR #42', 'ci-wait/42')
    claimNextQueuedTask('w1') // now running
    requeueTaskForRetry('t1', 30, 'CI wait #2: PR #42')

    const task = getTask('t1')
    expect(task?.status).toBe('queued')
    expect(task?.description).toBe('CI wait #2: PR #42')
    expect(task?.run_after).toBeTruthy()
    expect(task?.worker_id).toBeNull()

    // Not claimable until the delay passes
    expect(claimNextQueuedTask('w1')).toBeNull()
    db.prepare(`UPDATE tasks SET run_after = datetime('now', '-1 second') WHERE id = 't1'`).run()
    expect(claimNextQueuedTask('w1')?.id).toBe('t1')
  })

  it('requeueTaskForRetry keeps the description when none is given', () => {
    createQueuedTask('t1', repoId, 'Original description', 'branch-1')
    claimNextQueuedTask('w1')
    requeueTaskForRetry('t1', 30)
    expect(getTask('t1')?.description).toBe('Original description')
  })
})
