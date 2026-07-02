import { execSync } from 'child_process'
import { randomUUID } from 'crypto'
import {
  listIssues, createQueuedTask, hasActiveDuplicate, hasRecentCompletion,
  type RepoRow,
} from './db'
import { type RoleId } from './roles'

export const HEALTH_SCAN_INTERVAL = 10 * 60 * 1000 // 10 minutes

// Cap per check so a large repo seeds a steady trickle of tasks, not a flood.
// Files are sorted, so the next scan surfaces the next batch once these resolve.
export const MAX_FINDINGS_PER_CHECK = 10

export interface HealthFinding {
  description: string
  role:        RoleId
  workflow:    string
  branch:      string
}

// ── File classification ───────────────────────────────────────────────────────

// Extensions scanned for TODO/FIXME comments
const TODO_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt',
  'rb', 'php', 'cs', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'vue', 'svelte',
]

// Generated output, vendored code, and assets — never scanned
const EXCLUDED_DIRS_RE =
  /(^|\/)(node_modules|dist|build|out|vendor|target|coverage|__pycache__|\.next|\.venv|venv|public|static|assets|migrations)\//

// Languages with a file-based test convention we can detect. Languages with
// inline tests (e.g. Rust #[cfg(test)]) are excluded to avoid false positives.
const TESTABLE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go)$/

export function isTestFile(file: string): boolean {
  if (/(^|\/)(__tests__|tests?)\//.test(file)) return true
  const base = file.split('/').pop() ?? ''
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return true
  if (/^test_.+\.py$/.test(base) || /_test\.py$/.test(base)) return true
  if (/_test\.go$/.test(base)) return true
  if (base === 'conftest.py') return true
  return false
}

function stem(file: string): string {
  return (file.split('/').pop() ?? '').replace(/\.[^.]+$/, '')
}

// The source-file stem a test file covers: bar.test → bar, test_bar → bar, bar_test → bar
export function coveredStem(testFile: string): string {
  return stem(testFile)
    .replace(/\.(test|spec)$/, '')
    .replace(/^test_/, '')
    .replace(/_test$/, '')
}

function isTestableSource(file: string): boolean {
  if (!TESTABLE_EXT_RE.test(file)) return false
  if (EXCLUDED_DIRS_RE.test(file)) return false
  if (isTestFile(file)) return false
  if (/\.d\.ts$/.test(file)) return false
  if (/\.config\.[cm]?[jt]s$/.test(file)) return false
  const base = file.split('/').pop() ?? ''
  if (base.startsWith('__') || base.startsWith('.')) return false
  return true
}

export function listTrackedFiles(repoPath: string): string[] {
  try {
    return execSync('git ls-files', { cwd: repoPath, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

// ── Individual checks ─────────────────────────────────────────────────────────

export function scanTodos(repoPath: string): HealthFinding[] {
  const pathspecs = [
    ...TODO_EXTENSIONS.map((ext) => `"*.${ext}"`),
    '":!**/__tests__/**"', '":!**/test/**"', '":!**/tests/**"',
    '":!**/*.test.*"', '":!**/*.spec.*"',
    '":!**/node_modules/**"', '":!**/dist/**"', '":!**/build/**"',
    '":!**/vendor/**"', '":!**/target/**"',
  ].join(' ')

  let raw = ''
  try {
    raw = execSync(
      `git grep -n "TODO\\|FIXME" -- ${pathspecs}`,
      { cwd: repoPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    )
  } catch (e: unknown) {
    // git grep exits 1 when there are no matches — that's fine
    const err = e as { status?: number; stdout?: string }
    if (err.status !== 1) raw = err.stdout ?? ''
  }

  // Count TODOs per file; create one task per file that has any
  const counts = new Map<string, number>()
  for (const line of raw.split('\n')) {
    const file = line.split(':')[0]
    if (file) counts.set(file, (counts.get(file) ?? 0) + 1)
  }

  const findings: HealthFinding[] = []
  for (const file of [...counts.keys()].sort()) {
    const count = counts.get(file)!
    const slug = file.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40)
    findings.push({
      description: `Resolve ${count} TODO/FIXME comment${count > 1 ? 's' : ''} in ${file}`,
      role:        'RAZ-Dev',
      workflow:    'fix',
      branch:      `razdev/health-todo-${slug}`,
    })
    if (findings.length >= MAX_FINDINGS_PER_CHECK) break
  }
  return findings
}

export function scanMissingTests(repoPath: string): HealthFinding[] {
  const files = listTrackedFiles(repoPath)
  if (files.length === 0) return []

  const testFiles = files.filter(isTestFile)
  const sources   = files.filter(isTestableSource)
  if (sources.length === 0) return []

  // No test infrastructure at all — one strategy task beats N per-file tasks
  // that would each fail against a repo with no test framework configured.
  if (testFiles.length === 0) {
    return [{
      description: `No test infrastructure detected across ${sources.length} source files — evaluate the stack and set up an appropriate test framework with initial coverage`,
      role:        'RAZ-Ops',
      workflow:    'strategy',
      branch:      `razops/health-test-setup-${randomUUID().slice(0, 6)}`,
    }]
  }

  const covered  = new Set(testFiles.map(coveredStem))
  const findings: HealthFinding[] = []
  for (const file of [...sources].sort()) {
    if (covered.has(stem(file))) continue
    findings.push({
      description: `Add tests for ${file} — no test file found`,
      role:        'RAZ-QA',
      workflow:    'test',
      branch:      `razqa/health-test-${stem(file).toLowerCase().replace(/[^a-z0-9]/g, '-')}-${randomUUID().slice(0, 6)}`,
    })
    if (findings.length >= MAX_FINDINGS_PER_CHECK) break
  }
  return findings
}

export function scanUnqueuedIssues(repoId: number): HealthFinding[] {
  // Issues with no task at all are handled by the issue pipeline (POST /api/issues).
  // Here we just surface a reminder task if there are many open issues and none queued.
  const open = listIssues(repoId, 'open')
  if (open.length === 0) return []
  return [{
    description: `Triage ${open.length} open GitHub issue${open.length > 1 ? 's' : ''} — run issue pipeline to queue tasks`,
    role:        'RAZ-Ops',
    workflow:    'strategy',
    branch:      `razops/health-issue-triage-${randomUUID().slice(0, 6)}`,
  }]
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function runHealthScan(repo: RepoRow): HealthFinding[] {
  if (!repo.local_path) return []
  return [
    ...scanTodos(repo.local_path),
    ...scanMissingTests(repo.local_path),
    ...scanUnqueuedIssues(repo.id),
  ]
}

export async function seedHealthTasks(repo: RepoRow): Promise<number> {
  const findings = runHealthScan(repo)
  let queued = 0

  for (const finding of findings) {
    // Dedup: skip if an identical task ran recently or is already queued
    if (hasActiveDuplicate(repo.id, finding.description) || hasRecentCompletion(repo.id, finding.description)) continue

    const taskId = randomUUID()
    createQueuedTask(
      taskId,
      repo.id,
      finding.description,
      `${finding.branch}-${taskId.slice(0, 6)}`.slice(0, 100),
      finding.workflow,
      finding.role,
    )
    queued++
  }

  return queued
}
