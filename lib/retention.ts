import db from './db'

// Task rows are never deleted — history stays. Only the heavy per-task blobs
// (agent logs, message transcripts) and append-only auxiliary tables are pruned.
export const RETENTION = {
  taskLogBlobDays:      14,
  prStatusDays:         30,
  chatMessageDays:      30,
  agentMessageDays:     60,
  answeredQuestionDays: 30,
} as const

export interface RetentionStats {
  taskBlobsCleared:     number
  prStatusDeleted:      number
  chatMessagesDeleted:  number
  agentMessagesDeleted: number
  questionsDeleted:     number
}

export function runRetentionSweep(): RetentionStats {
  const blobs = db.prepare(`
    UPDATE tasks SET log_json = NULL, messages_json = NULL
    WHERE status IN ('complete', 'failed')
      AND completed_at IS NOT NULL
      AND completed_at < datetime('now', ?)
      AND (log_json IS NOT NULL OR messages_json IS NOT NULL)
  `).run(`-${RETENTION.taskLogBlobDays} days`)

  // Keep the newest pr_status row per task (the dashboard reads it); prune older history
  const pr = db.prepare(`
    DELETE FROM pr_status
    WHERE checked_at < datetime('now', ?)
      AND id NOT IN (SELECT MAX(id) FROM pr_status GROUP BY task_id)
  `).run(`-${RETENTION.prStatusDays} days`)

  const chat = db.prepare(`
    DELETE FROM chat_messages WHERE created_at < datetime('now', ?)
  `).run(`-${RETENTION.chatMessageDays} days`)

  const agentMsgs = db.prepare(`
    DELETE FROM agent_messages WHERE created_at < datetime('now', ?)
  `).run(`-${RETENTION.agentMessageDays} days`)

  // Unanswered questions are never pruned — they may still be waiting on the user
  const questions = db.prepare(`
    DELETE FROM agent_questions
    WHERE answered_at IS NOT NULL AND answered_at < datetime('now', ?)
  `).run(`-${RETENTION.answeredQuestionDays} days`)

  return {
    taskBlobsCleared:     blobs.changes,
    prStatusDeleted:      pr.changes,
    chatMessagesDeleted:  chat.changes,
    agentMessagesDeleted: agentMsgs.changes,
    questionsDeleted:     questions.changes,
  }
}

let scheduled = false

export function startRetentionSchedule(): void {
  if (scheduled) return
  scheduled = true
  runRetentionSweep()
  setInterval(runRetentionSweep, 24 * 60 * 60 * 1000)
}
