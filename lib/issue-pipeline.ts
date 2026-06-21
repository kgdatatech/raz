import { randomUUID } from 'crypto'
import { syncIssues } from './github'
import {
  upsertIssue, listIssues, getTaskForIssue,
  createQueuedTask, setTaskIssueNumber,
  type RepoRow, type IssueRow,
} from './db'
import { type RoleId } from './roles'

// ── Label → Role / Workflow ───────────────────────────────────────────────────

const LABEL_ROLE_MAP: { patterns: RegExp[]; role: RoleId; workflow: string }[] = [
  { patterns: [/\btest(ing)?\b/i, /\bcoverage\b/i],                                        role: 'RAZ-QA',   workflow: 'test'     },
  { patterns: [/\bdata\b/i, /\bdb\b/i, /\bdatabase\b/i, /\bmigration\b/i, /\bschema\b/i], role: 'RAZ-Data', workflow: 'feature'  },
  { patterns: [/\bops\b/i, /\binfra\b/i, /\bdevops\b/i, /\bci\b/i, /\bcd\b/i],           role: 'RAZ-Ops',  workflow: 'strategy' },
  { patterns: [/\bsecurity\b/i, /\bvuln\b/i, /\bcve\b/i],                                 role: 'RAZ-Sec',  workflow: 'audit'    },
  { patterns: [/\bbug\b/i, /\bfix\b/i, /\bregression\b/i, /\bcrash\b/i],                  role: 'RAZ-Dev',  workflow: 'fix'      },
]

export function roleFromLabels(labels: string[]): RoleId {
  for (const entry of LABEL_ROLE_MAP) {
    if (labels.some((l) => entry.patterns.some((p) => p.test(l)))) return entry.role
  }
  return 'RAZ-Dev'
}

export function workflowFromLabels(labels: string[]): string {
  for (const entry of LABEL_ROLE_MAP) {
    if (labels.some((l) => entry.patterns.some((p) => p.test(l)))) return entry.workflow
  }
  return 'feature'
}

export function branchForIssue(issueNumber: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '')
  return `razdev/issue-${issueNumber}-${slug}`
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

export interface IssuePipelineResult {
  queued:  number
  skipped: number
  issues:  Array<{ number: number; title: string; status: 'queued' | 'skipped' }>
}

export async function syncAndQueueIssues(repo: RepoRow): Promise<IssuePipelineResult> {
  // 1. Pull latest from GitHub and sync to local DB
  const remoteIssues = await syncIssues(repo.github_owner, repo.github_repo)
  for (const issue of remoteIssues) {
    upsertIssue(repo.id, issue)
  }

  // 2. Work from locally-stored open issues
  const openIssues: IssueRow[] = listIssues(repo.id, 'open')
  const result: IssuePipelineResult = { queued: 0, skipped: 0, issues: [] }

  for (const issue of openIssues) {
    // 3. Skip if already being handled (queued / running / complete)
    if (getTaskForIssue(repo.id, issue.number)) {
      result.skipped++
      result.issues.push({ number: issue.number, title: issue.title, status: 'skipped' })
      continue
    }

    const labels   = issue.labels ? (JSON.parse(issue.labels) as string[]) : []
    const role     = roleFromLabels(labels)
    const workflow = workflowFromLabels(labels)
    const branch   = branchForIssue(issue.number, issue.title)
    const taskId   = randomUUID()

    createQueuedTask(taskId, repo.id, `Fix issue #${issue.number}: ${issue.title}`, branch, workflow, role)
    setTaskIssueNumber(taskId, issue.number)

    result.queued++
    result.issues.push({ number: issue.number, title: issue.title, status: 'queued' })
  }

  return result
}
