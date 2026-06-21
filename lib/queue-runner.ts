import { execSync } from 'child_process'
import { randomUUID } from 'crypto'
import {
  getConfig, getNextQueuedTask, getRepoById, getTask,
  resetTaskToRunning, completeTask, failTask, saveTaskLog, activateHandoffs,
  hasRunningDuplicate, hasRecentCompletion, createQueuedTask,
  type TaskRow, type RepoRow,
} from './db'
import { runAgent } from './agent'
import { pushBranchAndOpenPR, mergePR, getPRStatus } from './github'
import { type RoleId, DEFAULT_ROLE, ROLE_IDS } from './roles'

let isProcessing = false
let started      = false

// Max number of CI wait retries before giving up (5s queue tick × 90 = 7.5 min)
const CI_WAIT_MAX = 90

function parseCIWaitRetry(description: string): number {
  const match = description.match(/CI wait #(\d+):/)
  return match ? parseInt(match[1]) : 1
}

// ── Merge + post-merge audit ──────────────────────────────────────────────────
// Shared by both handleReviewGate and handleCIGate to avoid duplication.
async function performMerge(
  prNumber:     number,
  parentTaskId: string,
  callerTaskId: string,
  repo:         RepoRow,
): Promise<void> {
  const parentTask = getTask(parentTaskId)
  await mergePR(repo.github_owner, repo.github_repo, prNumber)
  try { execSync(`git fetch origin`, { cwd: repo.local_path!, stdio: 'pipe' }) } catch {}
  activateHandoffs(parentTaskId)

  const auditId = randomUUID()
  createQueuedTask(
    auditId,
    repo.id,
    `Post-merge audit: PR #${prNumber} (${parentTask?.role ?? 'RAZ-Dev'}) — ${parentTask?.description.slice(0, 50) ?? ''}`,
    `razqa/audit-${prNumber}-${auditId.slice(0, 6)}`,
    'audit',
    'RAZ-QA',
    callerTaskId,
    'queued',
  )
}

// ── CI gate ───────────────────────────────────────────────────────────────────
// Called instead of running an agent when workflow='ci_wait'.
// Checks CI status and either merges, waits another tick, or queues a fix task.
async function handleCIGate(task: TaskRow, repo: RepoRow, prNumber: number): Promise<void> {
  const parentTaskId = task.parent_task_id!
  const parentTask   = getTask(parentTaskId)
  const status       = await getPRStatus(repo.github_owner, repo.github_repo, prNumber)

  if (status.merged) {
    activateHandoffs(parentTaskId)
    return
  }

  if (status.ciStatus === 'passing' || status.ciStatus === 'no_checks') {
    await performMerge(prNumber, parentTaskId, task.id, repo)
    return
  }

  if (status.ciStatus === 'pending') {
    const retry = parseCIWaitRetry(task.description) + 1
    if (retry <= CI_WAIT_MAX) {
      const waitId = randomUUID()
      createQueuedTask(
        waitId,
        repo.id,
        `CI wait #${retry}: PR #${prNumber} — ${parentTask?.description.slice(0, 50) ?? ''}`,
        `ci-wait/${prNumber}-${waitId.slice(0, 6)}`,
        'ci_wait',
        'RAZ-Ops',
        parentTaskId,
        'queued',
      )
    } else {
      // Timed out — give up and queue a fix task
      const fixId = randomUUID()
      createQueuedTask(
        fixId,
        repo.id,
        `Fix PR #${prNumber} CI timeout after ${Math.round(CI_WAIT_MAX * 5 / 60)} min: ${parentTask?.description.slice(0, 50) ?? ''}`,
        `raz-dev/fix-ci-timeout-${prNumber}-${fixId.slice(0, 6)}`,
        'fix',
        'RAZ-Dev',
        task.id,
        'queued',
      )
    }
    return
  }

  // ciStatus === 'failing' — queue RAZ-Dev fix with check names
  const fixId    = randomUUID()
  const failInfo = status.failingChecks.length > 0
    ? ` [${status.failingChecks.slice(0, 3).join(', ')}]`
    : ''
  createQueuedTask(
    fixId,
    repo.id,
    `Fix PR #${prNumber} CI failures${failInfo}: ${parentTask?.description.slice(0, 50) ?? ''}`,
    `raz-dev/fix-ci-${prNumber}-${fixId.slice(0, 6)}`,
    'fix',
    'RAZ-Dev',
    task.id,
    'queued',
  )
}

// ── Pre-merge gate ────────────────────────────────────────────────────────────
// Called after a workflow='review' task completes. Checks QA verdict then CI.
async function handleReviewGate(task: TaskRow, repo: RepoRow): Promise<void> {
  if (task.workflow !== 'review' || !task.parent_task_id) return

  const parentTask = getTask(task.parent_task_id)
  if (!parentTask?.pr_url) return

  const match    = parentTask.pr_url.match(/\/pull\/(\d+)/)
  const prNumber = match ? parseInt(match[1]) : 0
  if (!prNumber) return

  const status = await getPRStatus(repo.github_owner, repo.github_repo, prNumber)

  if (status.merged) {
    activateHandoffs(parentTask.id)
    return
  }

  if (status.state === 'closed') return

  if (status.approvals > 0 && status.rejections === 0) {
    // QA approved — now check CI before merging
    if (status.ciStatus === 'passing' || status.ciStatus === 'no_checks') {
      await performMerge(prNumber, parentTask.id, task.id, repo)
    } else if (status.ciStatus === 'pending') {
      // CI still running — queue a lightweight poller, no agent needed
      const waitId = randomUUID()
      createQueuedTask(
        waitId,
        repo.id,
        `CI wait #1: PR #${prNumber} — ${parentTask.description.slice(0, 60)}`,
        `ci-wait/${prNumber}-${waitId.slice(0, 6)}`,
        'ci_wait',
        'RAZ-Ops',
        parentTask.id,
        'queued',
      )
    } else {
      // CI is already failing — skip the wait, queue fix immediately with check names
      const fixId    = randomUUID()
      const failInfo = status.failingChecks.length > 0
        ? ` [${status.failingChecks.slice(0, 3).join(', ')}]`
        : ''
      createQueuedTask(
        fixId,
        repo.id,
        `Fix PR #${prNumber} CI failures${failInfo}: ${parentTask.description.slice(0, 50)}`,
        `raz-dev/fix-ci-${prNumber}-${fixId.slice(0, 6)}`,
        'fix',
        'RAZ-Dev',
        task.id,
        'queued',
      )
    }
  } else {
    // QA requested changes — queue RAZ-Dev fix
    const fixId   = randomUUID()
    const reason  = task.summary?.slice(0, 200) ?? 'Review requested changes — see GitHub PR for details.'
    createQueuedTask(
      fixId,
      repo.id,
      `Fix PR #${prNumber} review feedback: ${reason}`,
      `raz-dev/fix-pr${prNumber}-${fixId.slice(0, 6)}`,
      'fix',
      'RAZ-Dev',
      task.id,
      'queued',
    )
  }
}

// ── Main queue loop ───────────────────────────────────────────────────────────
async function processQueue(): Promise<void> {
  if (isProcessing) return

  const mode = getConfig('raz_mode') ?? 'standard'
  if (mode !== 'autonomous') return

  const task = getNextQueuedTask()
  if (!task) return

  const repo = getRepoById(task.repo_id)
  if (!repo?.local_path) return

  // Dedup: skip if an identical task is already running, or completed in the last 15 min
  if (hasRunningDuplicate(repo.id, task.description, task.id)) {
    failTask(task.id, 'Skipped — identical task already running')
    return
  }
  if (hasRecentCompletion(repo.id, task.description)) {
    failTask(task.id, 'Skipped — identical task completed within the last 15 minutes')
    return
  }

  // ci_wait tasks are handled directly — no agent needed
  if (task.workflow === 'ci_wait' && task.parent_task_id) {
    isProcessing = true
    resetTaskToRunning(task.id)
    try {
      const parentTask = getTask(task.parent_task_id)
      const match      = parentTask?.pr_url?.match(/\/pull\/(\d+)/)
      const prNumber   = match ? parseInt(match[1]) : 0
      if (prNumber) await handleCIGate(task, repo, prNumber)
      completeTask(task.id, null, `CI gate check — ${task.description}`, [])
    } catch (err) {
      failTask(task.id, `CI gate error: ${err}`)
    } finally {
      isProcessing = false
    }
    return
  }

  isProcessing = true
  resetTaskToRunning(task.id)

  const logBuffer: object[] = []
  let completionData: Record<string, unknown> | undefined

  try {
    // Fetch so origin/<baseBranch> is current before the worktree is created.
    // Do NOT merge into the local working tree — that would trigger Next.js HMR.
    try {
      execSync(`git fetch origin`, { cwd: repo.local_path, stdio: 'pipe' })
    } catch {}

    await runAgent(
      {
        taskId:      task.id,
        repoPath:    repo.local_path,
        description: task.description,
        branch:      task.branch,
        workflow:    task.workflow ?? 'feature',
        role:        (ROLE_IDS.includes(task.role as RoleId) ? task.role : DEFAULT_ROLE) as RoleId,
        repoId:      repo.id,
        github:      { owner: repo.github_owner, repo: repo.github_repo },
        baseBranch:  repo.default_branch,
      },
      (event) => {
        if (event.type !== 'tool_result') logBuffer.push({ ...event, ts: Date.now() })
        if (event.type === 'usage')    saveTaskLog(task.id, logBuffer)
        if (event.type === 'complete') completionData = { ...event.data, summary: event.message }
      },
    )

    saveTaskLog(task.id, logBuffer)

    if (completionData && !completionData.commit_skipped) {
      let commitsAhead = 0
      try {
        const r = execSync(
          `git rev-list origin/${repo.default_branch}..${task.branch} --count`,
          { cwd: repo.local_path, encoding: 'utf8' },
        ).trim()
        commitsAhead = parseInt(r, 10) || 0
      } catch {
        try {
          const r = execSync(
            `git rev-list ${repo.default_branch}..${task.branch} --count`,
            { cwd: repo.local_path, encoding: 'utf8' },
          ).trim()
          commitsAhead = parseInt(r, 10) || 0
        } catch {}
      }

      const summary = String(completionData.summary ?? task.description)
      const files   = (completionData.files_changed as string[]) ?? []

      if (commitsAhead === 0) {
        completeTask(task.id, null, summary, [])
        await handleReviewGate(task, repo)
        activateHandoffs(task.id)
        return
      }

      const prUrl = await pushBranchAndOpenPR({
        repoPath:   repo.local_path,
        owner:      repo.github_owner,
        repo:       repo.github_repo,
        branch:     task.branch,
        baseBranch: repo.default_branch,
        title:      `[${task.role}] ${task.description.slice(0, 60)}`,
        body: [
          `## RAZ Agent Task`,
          ``,
          `**Agent:** \`${task.role}\`  **Workflow:** \`${task.workflow}\``,
          `**Task:** ${task.description}`,
          ``,
          `**Summary:** ${summary}`,
          ``,
          `---`,
          `> Automated by RAZ (${task.role}) · Archon Systems`,
        ].join('\n'),
      })

      completeTask(task.id, prUrl, summary, files)

      const prNumber = parseInt(prUrl.split('/').pop() ?? '0', 10)
      if (prNumber) {
        if (task.workflow === 'review') {
          await handleReviewGate(task, repo)
        } else {
          // Queue pre-merge review — handoffs stay pending until after review + CI pass
          const reviewId = randomUUID()
          createQueuedTask(
            reviewId,
            repo.id,
            `Pre-merge review: PR #${prNumber} — ${task.description.slice(0, 60)}`,
            `razqa/pre-merge-${prNumber}-${reviewId.slice(0, 6)}`,
            'review',
            'RAZ-QA',
            task.id,
            'queued',
          )
        }
      }
    } else if (completionData?.commit_skipped) {
      const summary = String(completionData.summary ?? '')
      completeTask(task.id, null, summary, [])
      await handleReviewGate(task, repo)
      activateHandoffs(task.id)
    } else {
      failTask(task.id, 'Agent did not reach task_complete')
    }
  } catch (err) {
    saveTaskLog(task.id, logBuffer)
    failTask(task.id, String(err))
  } finally {
    isProcessing = false
  }
}

export function startQueueRunner(): void {
  if (started) return
  started = true
  setInterval(() => { processQueue().catch(() => { isProcessing = false }) }, 5_000)
}
