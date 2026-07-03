import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.hoisted(() => {
  process.env['RAZ_DB_PATH'] = ':memory:'
})

import db, { upsertRepo, createQueuedTask, completeTask, saveChatMessage, createAgentMessage, createQuestion, answerQuestion, savePrStatus, getTaskLog } from '@/lib/db'
import { runRetentionSweep, RETENTION } from '@/lib/retention'

function cleanDb() {
  db.prepare('DELETE FROM pr_status').run()
  db.prepare('DELETE FROM agent_questions').run()
  db.prepare('DELETE FROM agent_messages').run()
  db.prepare('DELETE FROM memory').run()
  db.prepare('DELETE FROM chat_messages').run()
  db.prepare('DELETE FROM tasks').run()
  db.prepare('DELETE FROM repos').run()
}

function backdate(table: string, column: string, id: string | number, days: number, idColumn = 'id') {
  db.prepare(`UPDATE ${table} SET ${column} = datetime('now', '-${days} days') WHERE ${idColumn} = ?`).run(id)
}

describe('runRetentionSweep()', () => {
  let repoId: number

  beforeEach(() => {
    cleanDb()
    repoId = upsertRepo('o', 'r', 'main').id
  })

  it('clears log blobs from tasks completed beyond the retention window', () => {
    createQueuedTask('old', repoId, 'Old task', 'b1')
    completeTask('old', null, 'done', [])
    db.prepare(`UPDATE tasks SET log_json = '[{"a":1}]', messages_json = '[]' WHERE id = 'old'`).run()
    backdate('tasks', 'completed_at', 'old', RETENTION.taskLogBlobDays + 1)

    const stats = runRetentionSweep()
    expect(stats.taskBlobsCleared).toBe(1)
    expect(getTaskLog('old')).toBeNull()
  })

  it('keeps blobs on recently completed and still-running tasks', () => {
    createQueuedTask('recent', repoId, 'Recent task', 'b1')
    completeTask('recent', null, 'done', [])
    db.prepare(`UPDATE tasks SET log_json = '[{"a":1}]' WHERE id = 'recent'`).run()

    createQueuedTask('running', repoId, 'Running task', 'b2')
    db.prepare(`UPDATE tasks SET status = 'running', log_json = '[{"a":1}]' WHERE id = 'running'`).run()
    backdate('tasks', 'created_at', 'running', 60)

    const stats = runRetentionSweep()
    expect(stats.taskBlobsCleared).toBe(0)
    expect(getTaskLog('recent')).not.toBeNull()
    expect(getTaskLog('running')).not.toBeNull()
  })

  it('prunes old pr_status rows but always keeps the newest per task', () => {
    createQueuedTask('t1', repoId, 'Task', 'b1')
    savePrStatus('t1', { prNumber: 1, state: 'open', ciStatus: 'pending', reviewDecision: 'none', merged: false })
    savePrStatus('t1', { prNumber: 1, state: 'open', ciStatus: 'passing', reviewDecision: 'none', merged: true })
    db.prepare(`UPDATE pr_status SET checked_at = datetime('now', '-${RETENTION.prStatusDays + 5} days')`).run()

    const stats = runRetentionSweep()
    expect(stats.prStatusDeleted).toBe(1)
    const remaining = db.prepare('SELECT * FROM pr_status').all() as { ci_status: string }[]
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.ci_status).toBe('passing')
  })

  it('prunes old chat and agent messages', () => {
    saveChatMessage(repoId, 'user', 'old message')
    saveChatMessage(repoId, 'user', 'new message')
    db.prepare(`UPDATE chat_messages SET created_at = datetime('now', '-${RETENTION.chatMessageDays + 1} days') WHERE content = 'old message'`).run()

    createQueuedTask('t1', repoId, 'Task', 'b1')
    const msgId = createAgentMessage({ repoId, fromRole: 'RAZ-Dev', toRole: 'RAZ-QA', fromTaskId: 't1', messageType: 'handoff', message: 'old handoff' })
    backdate('agent_messages', 'created_at', msgId, RETENTION.agentMessageDays + 1)

    const stats = runRetentionSweep()
    expect(stats.chatMessagesDeleted).toBe(1)
    expect(stats.agentMessagesDeleted).toBe(1)
    expect(db.prepare('SELECT COUNT(*) as c FROM chat_messages').get()).toEqual({ c: 1 })
  })

  it('prunes old answered questions but never unanswered ones', () => {
    createQueuedTask('t1', repoId, 'Task', 'b1')
    createQuestion('q-old', 't1', 'Old answered?')
    answerQuestion('q-old', 'yes')
    backdate('agent_questions', 'answered_at', 'q-old', RETENTION.answeredQuestionDays + 1)

    createQuestion('q-open', 't1', 'Still waiting?')
    db.prepare(`UPDATE agent_questions SET created_at = datetime('now', '-365 days') WHERE id = 'q-open'`).run()

    const stats = runRetentionSweep()
    expect(stats.questionsDeleted).toBe(1)
    const remaining = db.prepare('SELECT id FROM agent_questions').all() as { id: string }[]
    expect(remaining.map((r) => r.id)).toEqual(['q-open'])
  })

  it('prunes memory entries untouched for the retention window', () => {
    db.prepare(`INSERT INTO memory (repo_id, key, value, updated_at) VALUES (?, 'stale:note', 'old', datetime('now', '-${RETENTION.memoryDays + 1} days'))`).run(repoId)
    db.prepare(`INSERT INTO memory (repo_id, key, value) VALUES (?, 'fresh:note', 'new')`).run(repoId)

    const stats = runRetentionSweep()
    expect(stats.memoriesDeleted).toBe(1)
    const remaining = db.prepare('SELECT key FROM memory').all() as { key: string }[]
    expect(remaining.map((r) => r.key)).toEqual(['fresh:note'])
  })

  it('is a no-op on a fresh database', () => {
    const stats = runRetentionSweep()
    expect(stats).toEqual({
      taskBlobsCleared: 0, prStatusDeleted: 0, chatMessagesDeleted: 0,
      agentMessagesDeleted: 0, questionsDeleted: 0, memoriesDeleted: 0,
    })
  })
})
