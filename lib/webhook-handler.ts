import { createHmac, timingSafeEqual } from 'crypto'
import { randomUUID } from 'crypto'
import { getRepo, createQueuedTask, hasRecentCompletion, PRIORITY, type RepoRow } from './db'
import { upsertIssue, listIssues, getTaskForIssue, setTaskIssueNumber } from './db'
import { roleFromLabels, workflowFromLabels, branchForIssue } from './issue-pipeline'

// ── Signature verification ────────────────────────────────────────────────────

export function verifyGitHubSignature(secret: string, rawBody: string, header: string): boolean {
  if (!header.startsWith('sha256=')) return false
  try {
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
    const a = Buffer.from(expected)
    const b = Buffer.from(header)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

// ── Payload shapes (minimal — only fields we use) ─────────────────────────────

interface GitHubIssue {
  number: number
  title:  string
  body:   string | null
  state:  string
  labels: Array<{ name?: string }>
  assignee: { login: string } | null
}

interface GitHubPR {
  number:   number
  title:    string
  merged:   boolean
  html_url: string
}

interface GitHubReview {
  state: string  // 'approved' | 'changes_requested' | 'commented'
  body:  string | null
}

export interface GitHubPayload {
  action?:       string
  issue?:        GitHubIssue
  pull_request?: GitHubPR
  review?:       GitHubReview
  ref?:          string  // for push events
  repository: {
    owner: { login: string }
    name:  string
    default_branch: string
  }
}

// ── Result ────────────────────────────────────────────────────────────────────

export interface WebhookResult {
  action:      'queued' | 'skipped' | 'error'
  description: string
  taskId?:     string
}

// ── Event handlers ────────────────────────────────────────────────────────────

function handleIssueEvent(repo: RepoRow, payload: GitHubPayload): WebhookResult {
  const issue = payload.issue
  if (!issue) return { action: 'skipped', description: 'No issue in payload' }
  if (payload.action !== 'opened' && payload.action !== 'reopened') {
    return { action: 'skipped', description: `Ignoring issue.${payload.action}` }
  }

  const labels = issue.labels.map((l) => l.name ?? '').filter(Boolean)
  upsertIssue(repo.id, {
    number:   issue.number,
    title:    issue.title,
    body:     issue.body,
    state:    issue.state,
    labels,
    assignee: issue.assignee?.login ?? null,
  })

  const existing = getTaskForIssue(repo.id, issue.number)
  if (existing) {
    return { action: 'skipped', description: `Issue #${issue.number} already has task ${existing.id}` }
  }

  const role     = roleFromLabels(labels)
  const workflow = workflowFromLabels(labels)
  const branch   = branchForIssue(issue.number, issue.title)
  const taskId   = randomUUID()

  createQueuedTask(taskId, repo.id, `Fix issue #${issue.number}: ${issue.title}`, branch, workflow, role)
  setTaskIssueNumber(taskId, issue.number)

  return { action: 'queued', description: `Queued ${role} ${workflow} task for issue #${issue.number}`, taskId }
}

function handlePullRequestEvent(repo: RepoRow, payload: GitHubPayload): WebhookResult {
  const pr = payload.pull_request
  if (!pr) return { action: 'skipped', description: 'No pull_request in payload' }

  if (payload.action === 'opened') {
    const description = `Pre-merge review: PR #${pr.number} — ${pr.title.slice(0, 60)}`
    if (hasRecentCompletion(repo.id, description)) {
      return { action: 'skipped', description: `Review task for PR #${pr.number} recently completed` }
    }
    const taskId = randomUUID()
    createQueuedTask(
      taskId, repo.id, description,
      `razqa/pre-merge-${pr.number}-${taskId.slice(0, 6)}`,
      'review', 'RAZ-QA',
    )
    return { action: 'queued', description: `Queued RAZ-QA review for PR #${pr.number}`, taskId }
  }

  if (payload.action === 'closed' && pr.merged) {
    const description = `Post-merge audit: PR #${pr.number} — ${pr.title.slice(0, 60)}`
    if (hasRecentCompletion(repo.id, description)) {
      return { action: 'skipped', description: `Audit task for PR #${pr.number} recently completed` }
    }
    const taskId = randomUUID()
    createQueuedTask(
      taskId, repo.id, description,
      `razqa/audit-${pr.number}-${taskId.slice(0, 6)}`,
      'audit', 'RAZ-QA',
    )
    return { action: 'queued', description: `Queued RAZ-QA audit for merged PR #${pr.number}`, taskId }
  }

  return { action: 'skipped', description: `Ignoring pull_request.${payload.action}` }
}

function handleReviewEvent(repo: RepoRow, payload: GitHubPayload): WebhookResult {
  const pr     = payload.pull_request
  const review = payload.review
  if (!pr || !review) return { action: 'skipped', description: 'Missing PR or review in payload' }
  if (payload.action !== 'submitted') return { action: 'skipped', description: `Ignoring pull_request_review.${payload.action}` }
  if (review.state.toLowerCase() !== 'changes_requested') {
    return { action: 'skipped', description: `Ignoring review state: ${review.state}` }
  }

  const feedback  = (review.body ?? 'Human reviewer requested changes — see PR for details.').slice(0, 200)
  const description = `Fix PR #${pr.number} human review feedback: ${feedback}`
  const taskId = randomUUID()
  createQueuedTask(
    taskId, repo.id, description,
    `raz-dev/fix-pr${pr.number}-human-${taskId.slice(0, 6)}`,
    'fix', 'RAZ-Dev',
    undefined, 'queued', PRIORITY.HIGH,
  )
  return { action: 'queued', description: `Queued RAZ-Dev fix for human review on PR #${pr.number}`, taskId }
}

function handlePushEvent(repo: RepoRow, payload: GitHubPayload): WebhookResult {
  const defaultBranch = payload.repository.default_branch
  if (payload.ref !== `refs/heads/${defaultBranch}`) {
    return { action: 'skipped', description: `Push to non-default branch — ignoring` }
  }
  const description = `Health scan after push to ${defaultBranch}`
  if (hasRecentCompletion(repo.id, description)) {
    return { action: 'skipped', description: 'Health scan already queued recently' }
  }
  const taskId = randomUUID()
  createQueuedTask(
    taskId, repo.id, description,
    `razops/push-health-${taskId.slice(0, 6)}`,
    'strategy', 'RAZ-Ops',
  )
  return { action: 'queued', description: `Queued RAZ-Ops health scan after push to ${defaultBranch}`, taskId }
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

export async function handleGitHubWebhook(
  event:   string,
  payload: GitHubPayload,
): Promise<WebhookResult> {
  const owner   = payload.repository?.owner?.login
  const repoName = payload.repository?.name
  if (!owner || !repoName) return { action: 'error', description: 'Missing repository info in payload' }

  const repo = getRepo(owner, repoName)
  if (!repo) return { action: 'skipped', description: `Repo ${owner}/${repoName} not registered in RAZ` }

  switch (event) {
    case 'issues':              return handleIssueEvent(repo, payload)
    case 'pull_request':        return handlePullRequestEvent(repo, payload)
    case 'pull_request_review': return handleReviewEvent(repo, payload)
    case 'push':                return handlePushEvent(repo, payload)
    default:                    return { action: 'skipped', description: `Unhandled event: ${event}` }
  }
}
