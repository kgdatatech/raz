import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

const DB_DIR  = process.env.RAZ_DB_PATH ? path.dirname(process.env.RAZ_DB_PATH) : path.join(process.cwd(), '.raziel')
const DB_PATH = process.env.RAZ_DB_PATH ?? path.join(DB_DIR, 'raziel.db')

fs.mkdirSync(DB_DIR, { recursive: true })

const db = new Database(DB_PATH)

db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// ─── Migrations ───────────────────────────────────────────────────────────────

const VERSION = db.pragma('user_version', { simple: true }) as number

if (VERSION < 1) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      github_owner   TEXT NOT NULL,
      github_repo    TEXT NOT NULL,
      local_path     TEXT,
      default_branch TEXT NOT NULL DEFAULT 'main',
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(github_owner, github_repo)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT PRIMARY KEY,
      repo_id       INTEGER REFERENCES repos(id),
      description   TEXT NOT NULL,
      branch        TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'running',
      pr_url        TEXT,
      summary       TEXT,
      files_changed TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS memory (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id    INTEGER REFERENCES repos(id),
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(repo_id, key)
    );
  `)
  db.exec('PRAGMA user_version = 1')
}

if (VERSION < 2) {
  // Add columns to tasks (try/catch — SQLite has no ADD COLUMN IF NOT EXISTS)
  for (const stmt of [
    `ALTER TABLE tasks ADD COLUMN workflow TEXT DEFAULT 'feature'`,
    `ALTER TABLE tasks ADD COLUMN issue_number INTEGER`,
    `ALTER TABLE tasks ADD COLUMN plan TEXT`,
    `ALTER TABLE tasks ADD COLUMN error TEXT`,
  ]) {
    try { db.exec(stmt) } catch {}
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id   INTEGER REFERENCES repos(id),
      number    INTEGER NOT NULL,
      title     TEXT NOT NULL,
      body      TEXT,
      state     TEXT NOT NULL DEFAULT 'open',
      labels    TEXT,
      assignee  TEXT,
      synced_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(repo_id, number)
    );

    CREATE TABLE IF NOT EXISTS pr_status (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id         TEXT REFERENCES tasks(id),
      pr_number       INTEGER,
      state           TEXT,
      ci_status       TEXT,
      review_decision TEXT,
      merged          INTEGER DEFAULT 0,
      checked_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  db.exec('PRAGMA user_version = 2')
}

if (VERSION < 3) {
  try { db.exec(`ALTER TABLE tasks ADD COLUMN role TEXT DEFAULT 'RAZ-Dev'`) } catch {}
  db.exec('PRAGMA user_version = 3')
}

if (VERSION < 4) {
  try { db.exec(`ALTER TABLE tasks ADD COLUMN messages_json TEXT`) } catch {}
  db.exec('PRAGMA user_version = 4')
}

if (VERSION < 5) {
  try { db.exec(`ALTER TABLE tasks ADD COLUMN parent_task_id TEXT`) } catch {}
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id      INTEGER REFERENCES repos(id),
      from_role    TEXT NOT NULL,
      to_role      TEXT NOT NULL,
      from_task_id TEXT,
      to_task_id   TEXT,
      message_type TEXT NOT NULL DEFAULT 'delegation',
      message      TEXT NOT NULL,
      context      TEXT,
      result       TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  db.exec('PRAGMA user_version = 5')
}

if (VERSION < 6) {
  try { db.exec(`ALTER TABLE tasks ADD COLUMN log_json TEXT`) } catch {}
  db.exec('PRAGMA user_version = 6')
}

if (VERSION < 7) {
  try { db.exec(`ALTER TABLE tasks ADD COLUMN session_id TEXT`) } catch {}
  db.exec('PRAGMA user_version = 7')
}

if (VERSION < 8) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_questions (
      id          TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL,
      question    TEXT NOT NULL,
      options     TEXT,
      input_type  TEXT NOT NULL DEFAULT 'choice',
      answer      TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      answered_at TEXT
    )
  `)
  db.exec('PRAGMA user_version = 8')
}

if (VERSION < 9) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO system_config (key, value) VALUES ('raz_mode', 'standard');
    INSERT OR IGNORE INTO system_config (key, value) VALUES ('task_paused', '0');
  `)
  db.exec('PRAGMA user_version = 9')
}

if (VERSION < 10) {
  try { db.exec(`ALTER TABLE tasks ADD COLUMN worktree_path TEXT`) } catch {}
  db.exec('PRAGMA user_version = 10')
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RepoRow {
  id:             number
  github_owner:   string
  github_repo:    string
  local_path:     string | null
  default_branch: string
}

export interface TaskRow {
  id:             string
  repo_id:        number
  description:    string
  branch:         string
  status:         string
  workflow:       string
  role:           string
  issue_number:   number | null
  plan:           string | null
  pr_url:         string | null
  summary:        string | null
  error:          string | null
  files_changed:  string | null
  parent_task_id: string | null
  created_at:     string
  completed_at:   string | null
}

export interface IssueRow {
  id:        number
  repo_id:   number
  number:    number
  title:     string
  body:      string | null
  state:     string
  labels:    string | null
  assignee:  string | null
  synced_at: string
}

// ─── Repos ────────────────────────────────────────────────────────────────────

export function upsertRepo(owner: string, repo: string, defaultBranch: string, localPath?: string): RepoRow {
  db.prepare(`
    INSERT INTO repos (github_owner, github_repo, default_branch, local_path)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(github_owner, github_repo) DO UPDATE SET
      default_branch = excluded.default_branch,
      local_path     = COALESCE(excluded.local_path, local_path)
  `).run(owner, repo, defaultBranch, localPath ?? null)
  return db.prepare(`SELECT * FROM repos WHERE github_owner = ? AND github_repo = ?`).get(owner, repo) as RepoRow
}

export function getRepo(owner: string, repo: string): RepoRow | null {
  return (db.prepare(`SELECT * FROM repos WHERE github_owner = ? AND github_repo = ?`).get(owner, repo) as RepoRow) ?? null
}

export function getRepoById(id: number): RepoRow | null {
  return (db.prepare(`SELECT * FROM repos WHERE id = ?`).get(id) as RepoRow) ?? null
}

export function getNextQueuedTask(): TaskRow | null {
  return (db.prepare(`SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`).get() as TaskRow) ?? null
}

export function countQueuedTasks(): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM tasks WHERE status = 'queued'`).get() as { count: number }
  return row.count
}

export function updateRepoLocalPath(owner: string, repo: string, localPath: string) {
  db.prepare(`UPDATE repos SET local_path = ? WHERE github_owner = ? AND github_repo = ?`).run(localPath, owner, repo)
}

export function listRepos(): RepoRow[] {
  return db.prepare(`SELECT * FROM repos ORDER BY github_repo ASC`).all() as RepoRow[]
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

export function createTask(
  id: string,
  repoId: number,
  description: string,
  branch: string,
  workflow = 'feature',
  issueNumber?: number,
  role = 'RAZ-Dev',
): TaskRow {
  db.prepare(`
    INSERT INTO tasks (id, repo_id, description, branch, workflow, issue_number, role)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, repoId, description, branch, workflow, issueNumber ?? null, role)
  return db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow
}

export function createQueuedTask(
  id: string,
  repoId: number,
  description: string,
  branch: string,
  workflow = 'feature',
  role = 'RAZ-Dev',
  parentTaskId?: string,
): TaskRow {
  db.prepare(`
    INSERT INTO tasks (id, repo_id, description, branch, workflow, role, status, parent_task_id)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)
  `).run(id, repoId, description, branch, workflow, role, parentTaskId ?? null)
  return db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow
}

export function savePlan(taskId: string, plan: string) {
  db.prepare(`UPDATE tasks SET plan = ? WHERE id = ?`).run(plan, taskId)
}

export function saveTaskLog(taskId: string, log: object[]): void {
  db.prepare(`UPDATE tasks SET log_json = ? WHERE id = ?`).run(JSON.stringify(log), taskId)
}

export function getTaskLog(taskId: string): object[] | null {
  const row = db.prepare(`SELECT log_json FROM tasks WHERE id = ?`).get(taskId) as { log_json: string | null } | undefined
  if (!row?.log_json) return null
  try { return JSON.parse(row.log_json) } catch { return null }
}

export function completeTask(id: string, prUrl: string | null, summary: string, filesChanged: string[]) {
  db.prepare(`
    UPDATE tasks SET
      status       = 'complete',
      pr_url       = ?,
      summary      = ?,
      files_changed = ?,
      completed_at = datetime('now')
    WHERE id = ?
  `).run(prUrl, summary, JSON.stringify(filesChanged), id)
}

export function failTask(id: string, error: string) {
  db.prepare(`
    UPDATE tasks SET status = 'failed', error = ?, completed_at = datetime('now') WHERE id = ?
  `).run(error, id)
}

export function deleteTask(id: string) {
  db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id)
}

export function listTasks(repoId?: number): TaskRow[] {
  if (repoId !== undefined) {
    return db.prepare(`SELECT * FROM tasks WHERE repo_id = ? ORDER BY created_at DESC LIMIT 50`).all(repoId) as TaskRow[]
  }
  return db.prepare(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT 50`).all() as TaskRow[]
}

export function getTask(id: string): TaskRow | null {
  return (db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow) ?? null
}

export function saveTaskMessages(taskId: string, messages: unknown[]): void {
  db.prepare(`UPDATE tasks SET messages_json = ? WHERE id = ?`).run(JSON.stringify(messages), taskId)
}

export function getTaskMessages(taskId: string): unknown[] | null {
  const row = db.prepare(`SELECT messages_json FROM tasks WHERE id = ?`).get(taskId) as { messages_json: string | null } | undefined
  if (!row?.messages_json) return null
  try { return JSON.parse(row.messages_json) } catch { return null }
}

export function resetTaskToRunning(taskId: string): void {
  db.prepare(`UPDATE tasks SET status = 'running', error = NULL, completed_at = NULL WHERE id = ?`).run(taskId)
}

export function saveWorktreePath(taskId: string, worktreePath: string): void {
  db.prepare(`UPDATE tasks SET worktree_path = ? WHERE id = ?`).run(worktreePath, taskId)
}

export function clearWorktreePath(taskId: string): void {
  db.prepare(`UPDATE tasks SET worktree_path = NULL WHERE id = ?`).run(taskId)
}

export function saveSessionId(taskId: string, sessionId: string): void {
  db.prepare(`UPDATE tasks SET session_id = ? WHERE id = ?`).run(sessionId, taskId)
}

export function clearSessionId(taskId: string): void {
  db.prepare(`UPDATE tasks SET session_id = NULL WHERE id = ?`).run(taskId)
}

export function getSessionId(taskId: string): string | null {
  const row = db.prepare(`SELECT session_id FROM tasks WHERE id = ?`).get(taskId) as { session_id: string | null } | undefined
  return row?.session_id ?? null
}

// ─── Memory ───────────────────────────────────────────────────────────────────

export interface MemoryRow {
  id:         number
  repo_id:    number
  key:        string
  value:      string
  updated_at: string
}

export function setMemory(repoId: number, key: string, value: string) {
  db.prepare(`
    INSERT INTO memory (repo_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(repo_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(repoId, key, value)
}

export function getMemory(repoId: number): Record<string, string> {
  const rows = db.prepare(`SELECT key, value FROM memory WHERE repo_id = ?`).all(repoId) as { key: string; value: string }[]
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

export function listMemoryRows(repoId: number): MemoryRow[] {
  return db.prepare(`SELECT * FROM memory WHERE repo_id = ? ORDER BY updated_at DESC`).all(repoId) as MemoryRow[]
}

export function deleteMemory(repoId: number, key: string) {
  db.prepare(`DELETE FROM memory WHERE repo_id = ? AND key = ?`).run(repoId, key)
}

// ─── Issues ───────────────────────────────────────────────────────────────────

export function upsertIssue(repoId: number, issue: {
  number:   number
  title:    string
  body:     string | null
  state:    string
  labels:   string[]
  assignee: string | null
}) {
  db.prepare(`
    INSERT INTO issues (repo_id, number, title, body, state, labels, assignee)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo_id, number) DO UPDATE SET
      title    = excluded.title,
      body     = excluded.body,
      state    = excluded.state,
      labels   = excluded.labels,
      assignee = excluded.assignee,
      synced_at = datetime('now')
  `).run(repoId, issue.number, issue.title, issue.body, issue.state, JSON.stringify(issue.labels), issue.assignee)
}

export function listIssues(repoId: number, state = 'open'): IssueRow[] {
  return db.prepare(`SELECT * FROM issues WHERE repo_id = ? AND state = ? ORDER BY number DESC`).all(repoId, state) as IssueRow[]
}

export function getIssue(repoId: number, number: number): IssueRow | null {
  return (db.prepare(`SELECT * FROM issues WHERE repo_id = ? AND number = ?`).get(repoId, number) as IssueRow) ?? null
}

// ─── PR Status ────────────────────────────────────────────────────────────────

export function savePrStatus(taskId: string, data: {
  prNumber:       number
  state:          string
  ciStatus:       string
  reviewDecision: string
  merged:         boolean
}) {
  db.prepare(`
    INSERT INTO pr_status (task_id, pr_number, state, ci_status, review_decision, merged)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(taskId, data.prNumber, data.state, data.ciStatus, data.reviewDecision, data.merged ? 1 : 0)
}

export function getLatestPrStatus(taskId: string) {
  return db.prepare(`SELECT * FROM pr_status WHERE task_id = ? ORDER BY checked_at DESC LIMIT 1`).get(taskId)
}

export function setTaskParent(taskId: string, parentTaskId: string) {
  db.prepare(`UPDATE tasks SET parent_task_id = ? WHERE id = ?`).run(parentTaskId, taskId)
}

export function listChildTasks(parentTaskId: string): TaskRow[] {
  return db.prepare(`SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC`).all(parentTaskId) as TaskRow[]
}

// ─── Agent Messages ───────────────────────────────────────────────────────────

export interface AgentMessageRow {
  id:           number
  repo_id:      number
  from_role:    string
  to_role:      string
  from_task_id: string | null
  to_task_id:   string | null
  message_type: string
  message:      string
  context:      string | null
  result:       string | null
  created_at:   string
}

export function createAgentMessage(params: {
  repoId:      number
  fromRole:    string
  toRole:      string
  fromTaskId:  string
  toTaskId?:   string
  messageType: string
  message:     string
  context?:    string
}): number {
  const info = db.prepare(`
    INSERT INTO agent_messages (repo_id, from_role, to_role, from_task_id, to_task_id, message_type, message, context)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.repoId, params.fromRole, params.toRole,
    params.fromTaskId, params.toTaskId ?? null,
    params.messageType, params.message, params.context ?? null,
  )
  return info.lastInsertRowid as number
}

export function updateAgentMessageResult(id: number, result: string) {
  db.prepare(`UPDATE agent_messages SET result = ? WHERE id = ?`).run(result, id)
}

export function listAgentMessages(repoId: number): AgentMessageRow[] {
  return db.prepare(
    `SELECT * FROM agent_messages WHERE repo_id = ? ORDER BY created_at DESC LIMIT 100`
  ).all(repoId) as AgentMessageRow[]
}

// ─── Agent Questions ──────────────────────────────────────────────────────────

export interface AgentQuestionRow {
  id:          string
  task_id:     string
  question:    string
  options:     string | null
  input_type:  string
  answer:      string | null
  created_at:  string
  answered_at: string | null
}

export function createQuestion(
  id:        string,
  taskId:    string,
  question:  string,
  options?:  Array<{ label: string; description?: string }>,
  inputType?: string,
) {
  db.prepare(`
    INSERT INTO agent_questions (id, task_id, question, options, input_type)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, taskId, question, options ? JSON.stringify(options) : null, inputType ?? (options?.length ? 'choice' : 'text'))
}

export function getPendingQuestions(taskId: string): AgentQuestionRow[] {
  return db.prepare(
    `SELECT * FROM agent_questions WHERE task_id = ? AND answered_at IS NULL ORDER BY created_at ASC`
  ).all(taskId) as AgentQuestionRow[]
}

export function answerQuestion(id: string, answer: string) {
  db.prepare(
    `UPDATE agent_questions SET answer = ?, answered_at = datetime('now') WHERE id = ?`
  ).run(answer, id)
}

export function getQuestionAnswer(id: string): string | null {
  const row = db.prepare(
    `SELECT answer, answered_at FROM agent_questions WHERE id = ?`
  ).get(id) as { answer: string | null; answered_at: string | null } | undefined
  return row?.answered_at ? (row.answer ?? '') : null
}

// ─── System Config ────────────────────────────────────────────────────────────

export function getConfig(key: string): string | null {
  return db.prepare('SELECT value FROM system_config WHERE key = ?').pluck().get(key) as string | null ?? null
}

export function setConfig(key: string, value: string): void {
  db.prepare('INSERT INTO system_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

export function getAllConfig(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM system_config').all() as { key: string; value: string }[]
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

// ─── Status Metrics ───────────────────────────────────────────────────────────

export interface RoleMetric {
  role:     string
  complete: number
  failed:   number
  running:  number
  queued:   number
  total:    number
}

export interface WindowMetric {
  complete: number
  failed:   number
  total:    number
}

export interface PrHealthMetric {
  merged:      number
  openPassing: number
  openFailing: number
  openPending: number
}

export interface RecentFailure {
  id:          string
  description: string
  role:        string | null
  error:       string | null
  completedAt: string | null
}

export interface StatusMetrics {
  running:          number
  queued:           number
  pendingQuestions: number
  config:           Record<string, string>
  byRole:           RoleMetric[]
  last24h:          WindowMetric
  last7d:           WindowMetric
  prHealth:         PrHealthMetric
  recentFailures:   RecentFailure[]
  generatedAt:      string
}

export function getStatusMetrics(): StatusMetrics {
  const running = (db.prepare(
    `SELECT COUNT(*) as n FROM tasks WHERE status = 'running'`
  ).get() as { n: number }).n

  const queued = (db.prepare(
    `SELECT COUNT(*) as n FROM tasks WHERE status = 'queued'`
  ).get() as { n: number }).n

  const pendingQuestions = (db.prepare(
    `SELECT COUNT(*) as n FROM agent_questions WHERE answered_at IS NULL`
  ).get() as { n: number }).n

  const config = getAllConfig()

  const roleRows = db.prepare(`
    SELECT COALESCE(role, 'RAZ-Dev') as role, status, COUNT(*) as n
    FROM tasks GROUP BY COALESCE(role, 'RAZ-Dev'), status
  `).all() as { role: string; status: string; n: number }[]

  const roleMap = new Map<string, RoleMetric>()
  for (const r of roleRows) {
    if (!roleMap.has(r.role)) {
      roleMap.set(r.role, { role: r.role, complete: 0, failed: 0, running: 0, queued: 0, total: 0 })
    }
    const m = roleMap.get(r.role)!
    if (r.status === 'complete')     m.complete = r.n
    else if (r.status === 'failed')  m.failed   = r.n
    else if (r.status === 'running') m.running  = r.n
    else if (r.status === 'queued')  m.queued   = r.n
    m.total += r.n
  }
  const byRole = Array.from(roleMap.values()).sort((a, b) => b.total - a.total)

  const h24Rows = db.prepare(`
    SELECT status, COUNT(*) as n FROM tasks
    WHERE created_at >= datetime('now', '-1 day') GROUP BY status
  `).all() as { status: string; n: number }[]
  const last24h: WindowMetric = { complete: 0, failed: 0, total: 0 }
  for (const r of h24Rows) {
    if (r.status === 'complete')    last24h.complete = r.n
    else if (r.status === 'failed') last24h.failed   = r.n
    last24h.total += r.n
  }

  const d7Rows = db.prepare(`
    SELECT status, COUNT(*) as n FROM tasks
    WHERE created_at >= datetime('now', '-7 days') GROUP BY status
  `).all() as { status: string; n: number }[]
  const last7d: WindowMetric = { complete: 0, failed: 0, total: 0 }
  for (const r of d7Rows) {
    if (r.status === 'complete')    last7d.complete = r.n
    else if (r.status === 'failed') last7d.failed   = r.n
    last7d.total += r.n
  }

  const prRows = db.prepare(`
    SELECT p.ci_status, p.state, p.merged
    FROM pr_status p
    INNER JOIN (
      SELECT task_id, MAX(checked_at) AS latest FROM pr_status GROUP BY task_id
    ) m ON p.task_id = m.task_id AND p.checked_at = m.latest
  `).all() as { ci_status: string | null; state: string | null; merged: number }[]

  const prHealth: PrHealthMetric = { merged: 0, openPassing: 0, openFailing: 0, openPending: 0 }
  for (const p of prRows) {
    if (p.merged) {
      prHealth.merged++
    } else {
      const ci = (p.ci_status ?? '').toLowerCase()
      if (ci === 'success' || ci === 'passing')                        prHealth.openPassing++
      else if (ci === 'failure' || ci === 'failing' || ci === 'error') prHealth.openFailing++
      else                                                             prHealth.openPending++
    }
  }

  const recentFailures = db.prepare(`
    SELECT id, description, COALESCE(role, 'RAZ-Dev') as role, error,
           completed_at as completedAt
    FROM tasks WHERE status = 'failed'
    ORDER BY completed_at DESC LIMIT 10
  `).all() as RecentFailure[]

  return {
    running,
    queued,
    pendingQuestions,
    config,
    byRole,
    last24h,
    last7d,
    prHealth,
    recentFailures,
    generatedAt: new Date().toISOString(),
  }
}

// Capture stale worktrees BEFORE marking as failed so agent-cc can clean them up on next start
export const STALE_WORKTREES = db.prepare(`
  SELECT t.id, t.worktree_path, r.local_path AS repo_path
  FROM tasks t LEFT JOIN repos r ON t.repo_id = r.id
  WHERE t.status = 'running' AND t.worktree_path IS NOT NULL
`).all() as { id: string; worktree_path: string; repo_path: string | null }[]

// On startup, any task still 'running' was interrupted by a server restart
db.prepare(
  `UPDATE tasks SET status = 'failed', error = 'Interrupted by server restart', completed_at = datetime('now') WHERE status = 'running'`
).run()

export default db
