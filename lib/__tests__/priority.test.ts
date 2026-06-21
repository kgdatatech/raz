import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.hoisted(() => {
  process.env['RAZ_DB_PATH'] = ':memory:'
})

import db, {
  upsertRepo, createQueuedTask, getNextQueuedTask,
  PRIORITY, type TaskRow,
} from '@/lib/db'

function cleanDb() {
  db.prepare('DELETE FROM memory').run()
  db.prepare('DELETE FROM chat_messages').run()
  db.prepare('DELETE FROM tasks').run()
  db.prepare('DELETE FROM repos').run()
}

function seq(n: number): string[] {
  return Array.from({ length: n }, (_, i) => String(i))
}

describe('PRIORITY constants', () => {
  it('exports CRITICAL=3, HIGH=2, NORMAL=1', () => {
    expect(PRIORITY.CRITICAL).toBe(3)
    expect(PRIORITY.HIGH).toBe(2)
    expect(PRIORITY.NORMAL).toBe(1)
  })
})

describe('createQueuedTask() — priority storage', () => {
  let repoId: number
  beforeEach(() => { cleanDb(); repoId = upsertRepo('o', 'r', 'main').id })

  it('stores NORMAL by default', () => {
    createQueuedTask('t1', repoId, 'normal task', 'branch-1')
    const task = db.prepare("SELECT * FROM tasks WHERE id = 't1'").get() as TaskRow
    expect(task.priority).toBe(PRIORITY.NORMAL)
  })

  it('stores HIGH when specified', () => {
    createQueuedTask('t1', repoId, 'high task', 'branch-1', 'fix', 'RAZ-Dev', undefined, 'queued', PRIORITY.HIGH)
    const task = db.prepare("SELECT * FROM tasks WHERE id = 't1'").get() as TaskRow
    expect(task.priority).toBe(PRIORITY.HIGH)
  })

  it('stores CRITICAL when specified', () => {
    createQueuedTask('t1', repoId, 'critical task', 'branch-1', 'fix', 'RAZ-Dev', undefined, 'queued', PRIORITY.CRITICAL)
    const task = db.prepare("SELECT * FROM tasks WHERE id = 't1'").get() as TaskRow
    expect(task.priority).toBe(PRIORITY.CRITICAL)
  })
})

describe('getNextQueuedTask() — priority ordering', () => {
  let repoId: number
  beforeEach(() => { cleanDb(); repoId = upsertRepo('o', 'r', 'main').id })

  it('returns CRITICAL task before HIGH task queued earlier', () => {
    createQueuedTask('normal', repoId, 'do work',     'b1', 'feature', 'RAZ-Dev', undefined, 'queued', PRIORITY.NORMAL)
    createQueuedTask('high',   repoId, 'review fix',  'b2', 'fix',     'RAZ-Dev', undefined, 'queued', PRIORITY.HIGH)
    createQueuedTask('crit',   repoId, 'ci fix now',  'b3', 'fix',     'RAZ-Dev', undefined, 'queued', PRIORITY.CRITICAL)
    expect(getNextQueuedTask()!.id).toBe('crit')
  })

  it('returns HIGH task before NORMAL task queued earlier', () => {
    createQueuedTask('normal', repoId, 'do work',    'b1', 'feature', 'RAZ-Dev', undefined, 'queued', PRIORITY.NORMAL)
    createQueuedTask('high',   repoId, 'review fix', 'b2', 'fix',     'RAZ-Dev', undefined, 'queued', PRIORITY.HIGH)
    expect(getNextQueuedTask()!.id).toBe('high')
  })

  it('returns NORMAL tasks in FIFO order when priorities are equal', () => {
    createQueuedTask('first',  repoId, 'task A', 'b1')
    createQueuedTask('second', repoId, 'task B', 'b2')
    createQueuedTask('third',  repoId, 'task C', 'b3')
    expect(getNextQueuedTask()!.id).toBe('first')
  })

  it('returns null when queue is empty', () => {
    expect(getNextQueuedTask()).toBeNull()
  })

  it('respects priority across a sequence of dequeues', () => {
    createQueuedTask('n1', repoId, 'normal 1', 'b-n1', 'feature', 'RAZ-Dev', undefined, 'queued', PRIORITY.NORMAL)
    createQueuedTask('h1', repoId, 'high 1',   'b-h1', 'fix',     'RAZ-Dev', undefined, 'queued', PRIORITY.HIGH)
    createQueuedTask('c1', repoId, 'crit 1',   'b-c1', 'fix',     'RAZ-Dev', undefined, 'queued', PRIORITY.CRITICAL)
    createQueuedTask('h2', repoId, 'high 2',   'b-h2', 'fix',     'RAZ-Dev', undefined, 'queued', PRIORITY.HIGH)
    createQueuedTask('n2', repoId, 'normal 2', 'b-n2', 'feature', 'RAZ-Dev', undefined, 'queued', PRIORITY.NORMAL)

    const order: string[] = []
    for (const _ of seq(5)) {
      const t = getNextQueuedTask()
      if (!t) break
      order.push(t.id)
      db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(t.id)
    }

    expect(order[0]).toBe('c1')           // CRITICAL first
    expect(order[1]).toBe('h1')           // HIGH in FIFO order
    expect(order[2]).toBe('h2')
    expect(order[3]).toBe('n1')           // NORMAL in FIFO order
    expect(order[4]).toBe('n2')
  })
})
