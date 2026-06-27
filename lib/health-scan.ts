import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  listIssues, createQueuedTask, hasActiveDuplicate, hasRecentCompletion,
  type RepoRow,
} from './db'
import { type RoleId } from './roles'

export const HEALTH_SCAN_INTERVAL = 10 * 60 * 1000 // 10 minutes

export interface HealthFinding {
  description: string
  role:        RoleId
  workflow:    string
  branch:      string
}

// ── Individual checks ─────────────────────────────────────────────────────────

export function scanTodos(repoPath: string): HealthFinding[] {
  let raw = ''
  try {
    raw = execSync(
      `git grep -n "TODO\\|FIXME" -- "*.ts" "*.tsx" ":!**/__tests__/**" ":!**/*.test.ts" ":!**/*.test.tsx"`,
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
  for (const [file, count] of counts) {
    const slug = file.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40)
    findings.push({
      description: `Resolve ${count} TODO/FIXME comment${count > 1 ? 's' : ''} in ${file}`,
      role:        'RAZ-Dev',
      workflow:    'fix',
      branch:      `razdev/health-todo-${slug}`,
    })
  }
  return findings
}

export function scanMissingTests(repoPath: string): HealthFinding[] {
  const libDir   = path.join(repoPath, 'lib')
  const testDir  = path.join(repoPath, 'lib', '__tests__')

  let sourceFiles: string[] = []
  try {
    sourceFiles = fs.readdirSync(libDir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.startsWith('__'),
    )
  } catch {
    return []
  }

  const findings: HealthFinding[] = []
  for (const file of sourceFiles) {
    const base     = file.replace(/\.tsx?$/, '')
    const testPath = path.join(testDir, `${base}.test.ts`)
    if (!fs.existsSync(testPath)) {
      findings.push({
        description: `Add tests for lib/${file} — no test file found`,
        role:        'RAZ-QA',
        workflow:    'test',
        branch:      `razqa/health-test-${base.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${randomUUID().slice(0, 6)}`,
      })
    }
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
