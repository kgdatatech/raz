import { Octokit } from '@octokit/rest'
import { execSync } from 'child_process'

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })

export interface PROptions {
  repoPath:   string
  owner:      string
  repo:       string
  branch:     string
  baseBranch: string
  title:      string
  body:       string
}

export async function pushBranchAndOpenPR(opts: PROptions): Promise<string> {
  const { repoPath, owner, repo, branch, baseBranch, title, body } = opts
  execSync(`git push origin "${branch}"`, { cwd: repoPath })
  const pr = await octokit.pulls.create({ owner, repo, title, body, head: branch, base: baseBranch, draft: false })
  return pr.data.html_url
}

export async function getRepoInfo(owner: string, repo: string) {
  const { data } = await octokit.repos.get({ owner, repo })
  return { defaultBranch: data.default_branch, fullName: data.full_name, private: data.private }
}

// ─── Issues ───────────────────────────────────────────────────────────────────

export async function fetchIssue(owner: string, repo: string, number: number): Promise<string> {
  const { data } = await octokit.issues.get({ owner, repo, issue_number: number })
  const labels = data.labels.map((l) => (typeof l === 'string' ? l : l.name ?? '')).join(', ')
  const comments = data.comments > 0 ? `\nComments: ${data.comments}` : ''
  return [
    `Issue #${data.number}: ${data.title}`,
    `State: ${data.state}`,
    `Labels: ${labels || 'none'}`,
    `Assignee: ${data.assignee?.login ?? 'unassigned'}`,
    comments,
    `\nBody:\n${data.body ?? '(no body)'}`,
  ].filter(Boolean).join('\n')
}

export async function listOpenIssues(owner: string, repo: string, limit = 20): Promise<string> {
  const { data } = await octokit.issues.listForRepo({ owner, repo, state: 'open', per_page: limit, sort: 'created', direction: 'desc' })
  if (data.length === 0) return 'No open issues.'
  return data
    .map((i) => {
      const labels = i.labels.map((l) => (typeof l === 'string' ? l : l.name ?? '')).join(', ')
      return `#${i.number} [${labels || 'no label'}] ${i.title}`
    })
    .join('\n')
}

export async function syncIssues(owner: string, repo: string): Promise<{
  number: number; title: string; body: string | null; state: string; labels: string[]; assignee: string | null
}[]> {
  const { data } = await octokit.issues.listForRepo({ owner, repo, state: 'all', per_page: 100 })
  return data.map((i) => ({
    number:   i.number,
    title:    i.title,
    body:     i.body ?? null,
    state:    i.state,
    labels:   i.labels.map((l) => (typeof l === 'string' ? l : l.name ?? '')),
    assignee: i.assignee?.login ?? null,
  }))
}

// ─── PR Status ────────────────────────────────────────────────────────────────

export async function getPRStatus(owner: string, repo: string, prNumber: number) {
  const [prRes, reviewsRes, checksRes] = await Promise.all([
    octokit.pulls.get({ owner, repo, pull_number: prNumber }),
    octokit.pulls.listReviews({ owner, repo, pull_number: prNumber }),
    octokit.checks.listForRef({ owner, repo, ref: `refs/pull/${prNumber}/head` }).catch(() => ({ data: { check_runs: [] } })),
  ])

  const pr      = prRes.data
  const reviews = reviewsRes.data
  const checks  = checksRes.data.check_runs

  const latestReviews = new Map<string, string>()
  for (const r of reviews) {
    if (r.user?.login) latestReviews.set(r.user.login, r.state)
  }

  const approved  = [...latestReviews.values()].filter((s) => s === 'APPROVED').length
  const rejected  = [...latestReviews.values()].filter((s) => s === 'CHANGES_REQUESTED').length

  // Distinguish pending (still running) from failing (completed with failure)
  // conclusion is null while a check is still in_progress/queued
  const pendingChecks = checks.filter((c) => c.conclusion === null)
  const failedChecks  = checks.filter(
    (c) => c.conclusion !== null && c.conclusion !== 'success' && c.conclusion !== 'skipped',
  )
  let ciStatus: 'no_checks' | 'passing' | 'pending' | 'failing'
  if (checks.length === 0)        ciStatus = 'no_checks'
  else if (pendingChecks.length)  ciStatus = 'pending'
  else if (failedChecks.length)   ciStatus = 'failing'
  else                            ciStatus = 'passing'

  return {
    prNumber,
    state:          pr.state,
    merged:         pr.merged,
    title:          pr.title,
    reviewDecision: (pr as unknown as Record<string, unknown>).review_decision as string ?? 'none',
    approvals:      approved,
    rejections:     rejected,
    ciStatus,
    failingChecks:  failedChecks.map((c) => `${c.name}: ${c.conclusion}`),
    checkCount:     checks.length,
    url:            pr.html_url,
  }
}

export async function addPRComment(owner: string, repo: string, prNumber: number, body: string): Promise<void> {
  await octokit.issues.createComment({ owner, repo, issue_number: prNumber, body })
}

// ─── PR Management ────────────────────────────────────────────────────────────

export interface PRDetails {
  number:         number
  title:          string
  body:           string | null
  state:          string
  merged:         boolean
  mergeableState: string | null
  headBranch:     string
  baseBranch:     string
  author:         string
  createdAt:      string
  files:          { filename: string; additions: number; deletions: number; status: string }[]
  comments:       { author: string; body: string; createdAt: string }[]
  ciStatus:       string
  approvals:      number
}

export async function getPRDetails(owner: string, repo: string, prNumber: number): Promise<PRDetails> {
  const [prRes, filesRes, commentsRes, checksRes, reviewsRes] = await Promise.all([
    octokit.pulls.get({ owner, repo, pull_number: prNumber }),
    octokit.pulls.listFiles({ owner, repo, pull_number: prNumber, per_page: 50 }),
    octokit.issues.listComments({ owner, repo, issue_number: prNumber, per_page: 30 }),
    octokit.checks.listForRef({ owner, repo, ref: `refs/pull/${prNumber}/head` }).catch(() => ({ data: { check_runs: [] } })),
    octokit.pulls.listReviews({ owner, repo, pull_number: prNumber }),
  ])
  const pr     = prRes.data
  const checks = checksRes.data.check_runs
  const ciOk   = checks.every((c) => c.conclusion === 'success' || c.conclusion === 'skipped')
  const ciStatus = checks.length === 0 ? 'no_checks' : ciOk ? 'passing' : 'failing'
  const latestReviews = new Map<string, string>()
  for (const r of reviewsRes.data) { if (r.user?.login) latestReviews.set(r.user.login, r.state) }
  const approvals = [...latestReviews.values()].filter((s) => s === 'APPROVED').length

  return {
    number:         pr.number,
    title:          pr.title,
    body:           pr.body ?? null,
    state:          pr.state,
    merged:         pr.merged ?? false,
    mergeableState: (pr as Record<string, unknown>).mergeable_state as string ?? null,
    headBranch:     pr.head.ref,
    baseBranch:     pr.base.ref,
    author:         pr.user?.login ?? 'unknown',
    createdAt:      pr.created_at,
    files:          filesRes.data.map((f) => ({ filename: f.filename, additions: f.additions, deletions: f.deletions, status: f.status })),
    comments:       commentsRes.data.map((c) => ({ author: c.user?.login ?? 'unknown', body: c.body ?? '', createdAt: c.created_at })),
    ciStatus,
    approvals,
  }
}

export async function mergePR(owner: string, repo: string, prNumber: number, method: 'merge' | 'squash' | 'rebase' = 'squash'): Promise<void> {
  await octokit.pulls.merge({ owner, repo, pull_number: prNumber, merge_method: method })
}

export async function closePR(owner: string, repo: string, prNumber: number): Promise<void> {
  await octokit.pulls.update({ owner, repo, pull_number: prNumber, state: 'closed' })
}

export async function reopenPR(owner: string, repo: string, prNumber: number): Promise<void> {
  await octokit.pulls.update({ owner, repo, pull_number: prNumber, state: 'open' })
}

export async function getPRDiff(owner: string, repo: string, prNumber: number): Promise<string> {
  const res = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner, repo, pull_number: prNumber,
    headers: { accept: 'application/vnd.github.v3.diff' },
  })
  return String(res.data).slice(0, 40_000)
}

export async function getPRFileDiff(owner: string, repo: string, prNumber: number, filename: string): Promise<string> {
  const { data } = await octokit.pulls.listFiles({ owner, repo, pull_number: prNumber, per_page: 100 })
  const file = data.find((f) => f.filename === filename)
  if (!file) return `File "${filename}" not found in PR #${prNumber}. Use get_pr_summary to see the file list.`
  return [
    `File: ${file.filename}`,
    `Status: ${file.status}  +${file.additions}/-${file.deletions} lines`,
    '',
    file.patch ?? '(no patch — binary file or diff too large for GitHub API)',
  ].join('\n').slice(0, 8_000)
}

export async function createPRReview(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
): Promise<string> {
  const res = await octokit.pulls.createReview({ owner, repo, pull_number: prNumber, body, event })
  return res.data.html_url ?? 'Review posted.'
}

export async function listOpenPRs(owner: string, repo: string): Promise<string> {
  const { data } = await octokit.pulls.list({ owner, repo, state: 'open', per_page: 20 })
  if (data.length === 0) return 'No open pull requests.'
  return data.map((pr) =>
    `PR #${pr.number} [${pr.head.ref} → ${pr.base.ref}] "${pr.title}" by ${pr.user?.login ?? 'unknown'} (${pr.created_at.slice(0, 10)})`
  ).join('\n')
}
