import { execSync } from 'child_process'
import { randomUUID } from 'crypto'
import {
  getConfig, getNextQueuedTask, getRepoById,
  resetTaskToRunning, completeTask, failTask, saveTaskLog, activateHandoffs,
  hasRunningDuplicate, hasRecentCompletion, createQueuedTask,
} from './db'
import { runAgent } from './agent'
import { pushBranchAndOpenPR, mergePR } from './github'
import { type RoleId, DEFAULT_ROLE, ROLE_IDS } from './roles'

let isProcessing = false
let started      = false

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
        await mergePR(repo.github_owner, repo.github_repo, prNumber)
        try { execSync(`git fetch origin`, { cwd: repo.local_path, stdio: 'pipe' }) } catch {}

        // Auto-queue RAZ-QA code review for every merged PR
        const reviewId = randomUUID()
        createQueuedTask(
          reviewId,
          repo.id,
          `Code review: PR #${prNumber} (${task.role ?? 'RAZ-Dev'}) — ${task.description.slice(0, 60)}`,
          `razqa/review-${prNumber}-${reviewId.slice(0, 6)}`,
          'audit',
          'RAZ-QA',
          task.id,
          'queued',
        )
      }
      activateHandoffs(task.id)
    } else if (completionData?.commit_skipped) {
      completeTask(task.id, null, String(completionData.summary ?? ''), [])
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
