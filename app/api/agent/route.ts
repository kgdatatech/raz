import { NextRequest } from 'next/server'
import { randomUUID } from 'crypto'
import { execSync } from 'child_process'
import { getActiveAgentRunner, isAgentRunnerAvailable, normalizeAgentRunner, runAgent } from '@/lib/agent'
import { pushBranchAndOpenPR } from '@/lib/github'
import { getRepo, upsertRepo, createTask, createQueuedTask, completeTask, failTask, getTask, getTaskMessages, resetTaskToRunning, saveTaskLog, clearSessionId, activateHandoffs, PRIORITY } from '@/lib/db'
import { handleReviewGate } from '@/lib/queue-runner'
import { type RoleId, DEFAULT_ROLE, ROLE_IDS } from '@/lib/roles'

export const runtime    = 'nodejs'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  const { owner, repo, description, workflow = 'feature', issueNumber, role: rawRole, resumeTaskId, baseBranch: bodyBaseBranch } = await req.json()
  const role: RoleId = ROLE_IDS.includes(rawRole) ? rawRole : DEFAULT_ROLE

  if (!owner || !repo || !description) {
    return new Response(JSON.stringify({ error: 'Missing required fields: owner, repo, description' }), { status: 400 })
  }

  const repoRow = getRepo(owner, repo)
  if (!repoRow?.local_path) {
    return new Response(JSON.stringify({ error: 'Local path not configured for this repo.' }), { status: 400 })
  }

  const repoPath   = repoRow.local_path
  const baseBranch = bodyBaseBranch?.trim() || repoRow.default_branch

  let taskId: string
  let branch: string
  let runner = getActiveAgentRunner()
  let checkpointMessages: unknown[] | null = null

  if (resumeTaskId) {
    const existing = getTask(resumeTaskId)
    if (!existing) {
      return new Response(JSON.stringify({ error: 'Task not found for resume.' }), { status: 404 })
    }
    taskId = resumeTaskId
    branch = existing.branch
    const existingRunner = normalizeAgentRunner(existing.runner)
    runner = existingRunner && isAgentRunnerAvailable(existingRunner) ? existingRunner : runner
    // Only carry checkpoint messages for interrupted tasks — completed tasks restart clean
    if (existing.status !== 'complete') {
      checkpointMessages = getTaskMessages(resumeTaskId)
    } else {
      clearSessionId(resumeTaskId)
    }
    resetTaskToRunning(taskId)
  } else {
    taskId = randomUUID()
    const taskSlug = description.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20).replace(/-$/, '')
    const roleSlug = role.toLowerCase().slice(0, 12)
    branch         = `${roleSlug}/${taskSlug}-${taskId.slice(0, 6)}`.slice(0, 50)
    upsertRepo(owner, repo, baseBranch, repoPath)
    createTask(taskId, repoRow.id, description, branch, workflow, issueNumber, role, runner)
  }

  const encoder    = new TextEncoder()
  const abort      = new AbortController()

  const stream = new ReadableStream({
    cancel() { abort.abort() },
    async start(controller) {
      function send(data: object) {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {}
      }

      const keepalive = setInterval(() => {
        try { controller.enqueue(encoder.encode(': keepalive\n\n')) } catch {}
      }, 25_000)

      // Fetch from remote so origin/<baseBranch> is current.
      // We intentionally do NOT merge into the local working tree here —
      // merging would modify tracked files and trigger Next.js HMR, restarting the
      // dev server and killing this SSE stream. Worktrees branch from origin/<baseBranch>
      // directly, so they always get the latest code without touching the main tree.
      try {
        execSync(`git fetch origin`, { cwd: repoPath, stdio: 'pipe' })
        send({ type: 'thinking', message: `Fetched origin/${baseBranch}` })
      } catch {
        send({ type: 'thinking', message: `Warning: could not fetch from origin — proceeding with cached state` })
      }

      // Buffer log entries — skip heavy tool_result bodies to keep size manageable
      const logBuffer: object[] = []

      try {
        let completionData: Record<string, unknown> | undefined

        await runAgent(
          {
            taskId,
            repoPath,
            description,
            branch,
            workflow,
            role,
            repoId:             repoRow.id,
            issueNumber,
            github:             { owner, repo },
            checkpointMessages: checkpointMessages ?? undefined,
            baseBranch,
            runner,
          },
          (event) => {
            send(event)
            if (event.type !== 'tool_result') {
              logBuffer.push({ ...event, ts: Date.now() })
            } else {
              // Save truncated tool_result so we know what was read, without storing full file contents
              logBuffer.push({ type: event.type, message: event.message.slice(0, 200), ts: Date.now() })
            }
            if (event.type === 'usage') saveTaskLog(taskId, logBuffer)
            if (event.type === 'complete') completionData = { ...event.data, summary: event.message }
          },
          abort.signal,
        )

        saveTaskLog(taskId, logBuffer)

        if (completionData && !completionData.commit_skipped) {
          // Check whether the agent actually committed anything before attempting a PR.
          // Must reference the feature branch by name, not HEAD — HEAD points to master
          // in the main repo, not to the worktree branch where commits were made.
          let commitsAhead = 0
          try {
            const result = execSync(
              `git rev-list origin/${baseBranch}..${branch} --count`,
              { cwd: repoPath, encoding: 'utf8' }
            ).trim()
            commitsAhead = parseInt(result, 10) || 0
          } catch {
            try {
              // Fallback: compare against local base branch if remote ref isn't available
              const result = execSync(
                `git rev-list ${baseBranch}..${branch} --count`,
                { cwd: repoPath, encoding: 'utf8' }
              ).trim()
              commitsAhead = parseInt(result, 10) || 0
            } catch { commitsAhead = 0 }
          }

          if (commitsAhead === 0) {
            // Read-only task (audit/strategy) — no commits, no PR needed
            const summary = String(completionData.summary ?? description)
            completeTask(taskId, null, summary, [])
            const completed = getTask(taskId)
            if (completed) await handleReviewGate(completed, repoRow)
            if (workflow !== 'review') activateHandoffs(taskId)
            send({ type: 'complete', message: 'Assessment complete. No code changes — PR skipped.', data: { branch, taskId } })
          } else {
          send({ type: 'thinking', message: 'Opening pull request...' })
          try {
            const summary = String(completionData.summary ?? description)
            const files   = (completionData.files_changed as string[]) ?? []
            const notes   = completionData.notes ? `\n\n**Notes for reviewer:** ${completionData.notes}` : ''

            const prUrl = await pushBranchAndOpenPR({
              repoPath,
              owner,
              repo,
              branch,
              baseBranch,
              title: `[${role}] ${description.slice(0, 60)}`,
              body: [
                `## RAZ Agent Task`,
                ``,
                `**Agent:** \`${role}\`  **Workflow:** \`${workflow}\``,
                issueNumber ? `**Linked Issue:** #${issueNumber}` : '',
                `**Task:** ${description}`,
                ``,
                `**Summary:** ${summary}${notes}`,
                ``,
                files.length > 0 ? `**Files changed:**\n${files.map((f) => `- \`${f}\``).join('\n')}` : '',
                ``,
                `---`,
                `> Automated by RAZ (${role}) · Archon Systems`,
                `> Review carefully before merging.`,
              ].filter((l) => l !== undefined).join('\n'),
            })

            completeTask(taskId, prUrl, summary, files)
            send({ type: 'complete', message: 'PR opened.', data: { prUrl, branch, taskId } })

            const prNumber = parseInt(prUrl.split('/').pop() ?? '0', 10)
            if (prNumber && workflow !== 'review') {
              const reviewId = randomUUID()
              createQueuedTask(
                reviewId,
                repoRow.id,
                `Pre-merge review: PR #${prNumber} — ${description.slice(0, 60)}`,
                `razqa/pre-merge-${prNumber}-${reviewId.slice(0, 6)}`,
                'review',
                'RAZ-QA',
                taskId,
                'queued',
                PRIORITY.NORMAL,
                runner,
              )
              send({ type: 'thinking', message: `Queued pre-merge review for PR #${prNumber}` })
            }
          } catch (e) {
            failTask(taskId, `PR failed: ${e}`)
            send({ type: 'error', message: `Task complete but PR failed: ${e}` })
          }
          } // end commitsAhead > 0
        } else if (completionData?.commit_skipped) {
          completeTask(taskId, null, String(completionData.summary ?? ''), [])
          const completed = getTask(taskId)
          if (completed) await handleReviewGate(completed, repoRow)
          if (workflow !== 'review') activateHandoffs(taskId)
        } else {
          // Agent emitted an error event and returned without completing — mark DB
          failTask(taskId, 'Agent did not reach task_complete')
        }
      } catch (err) {
        saveTaskLog(taskId, logBuffer)
        failTask(taskId, String(err))
        send({ type: 'error', message: `Fatal: ${err}` })
      } finally {
        clearInterval(keepalive)
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    },
  })
}
