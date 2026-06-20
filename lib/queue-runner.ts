import { execSync } from 'child_process'
import {
  getConfig, getNextQueuedTask, getRepoById,
  resetTaskToRunning, completeTask, failTask, saveTaskLog,
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

  isProcessing = true
  resetTaskToRunning(task.id)

  const logBuffer: object[] = []
  let completionData: Record<string, unknown> | undefined

  try {
    // Sync base branch before starting
    try {
      execSync(`git fetch origin`, { cwd: repo.local_path, stdio: 'pipe' })
      execSync(`git merge --ff-only origin/${repo.default_branch}`, { cwd: repo.local_path, stdio: 'pipe' })
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
        try {
          execSync(`git fetch origin`, { cwd: repo.local_path, stdio: 'pipe' })
          execSync(`git merge --ff-only origin/${repo.default_branch}`, { cwd: repo.local_path, stdio: 'pipe' })
        } catch {}
      }
    } else if (completionData?.commit_skipped) {
      completeTask(task.id, null, String(completionData.summary ?? ''), [])
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
