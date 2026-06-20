import { NextRequest } from 'next/server'
import { randomUUID } from 'crypto'
import { execSync } from 'child_process'
import { runAgent } from '@/lib/agent'
import { pushBranchAndOpenPR } from '@/lib/github'
import { getRepo, upsertRepo, createTask, completeTask, failTask, getTask, getTaskMessages, resetTaskToRunning, saveTaskLog } from '@/lib/db'
import { type RoleId, DEFAULT_ROLE, ROLE_IDS } from '@/lib/roles'

export const runtime    = 'nodejs'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  const { owner, repo, description, workflow = 'feature', issueNumber, role: rawRole, resumeTaskId } = await req.json()
  const role: RoleId = ROLE_IDS.includes(rawRole) ? rawRole : DEFAULT_ROLE

  if (!owner || !repo || !description) {
    return new Response(JSON.stringify({ error: 'Missing required fields: owner, repo, description' }), { status: 400 })
  }

  const repoRow = getRepo(owner, repo)
  if (!repoRow?.local_path) {
    return new Response(JSON.stringify({ error: 'Local path not configured for this repo.' }), { status: 400 })
  }

  const repoPath   = repoRow.local_path
  const baseBranch = repoRow.default_branch

  let taskId: string
  let branch: string
  let checkpointMessages: unknown[] | null = null

  if (resumeTaskId) {
    const existing = getTask(resumeTaskId)
    if (!existing) {
      return new Response(JSON.stringify({ error: 'Task not found for resume.' }), { status: 404 })
    }
    taskId             = resumeTaskId
    branch             = existing.branch
    checkpointMessages = getTaskMessages(resumeTaskId)
    resetTaskToRunning(taskId)
  } else {
    taskId = randomUUID()
    const taskSlug = description.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20).replace(/-$/, '')
    const roleSlug = role.toLowerCase().slice(0, 12)
    branch         = `${roleSlug}/${taskSlug}-${taskId.slice(0, 6)}`.slice(0, 50)
    upsertRepo(owner, repo, baseBranch, repoPath)
    createTask(taskId, repoRow.id, description, branch, workflow, issueNumber, role)
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
          // Check whether the agent actually committed anything before attempting a PR
          let commitsAhead = 0
          try {
            const result = execSync(
              `git rev-list origin/${baseBranch}..HEAD --count`,
              { cwd: repoPath, encoding: 'utf8' }
            ).trim()
            commitsAhead = parseInt(result, 10) || 0
          } catch { commitsAhead = 0 }

          if (commitsAhead === 0) {
            // Read-only task (audit/strategy) — no commits, no PR needed
            const summary = String(completionData.summary ?? description)
            completeTask(taskId, null, summary, [])
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
          } catch (e) {
            failTask(taskId, `PR failed: ${e}`)
            send({ type: 'error', message: `Task complete but PR failed: ${e}` })
          }
          } // end commitsAhead > 0
        } else if (completionData?.commit_skipped) {
          completeTask(taskId, null, String(completionData.summary ?? ''), [])
        } else {
          // Agent emitted an error event and returned without completing — mark DB
          failTask(taskId, 'Agent did not reach task_complete')
        }
      } catch (err) {
        saveTaskLog(taskId, logBuffer)
        failTask(taskId, String(err))
        send({ type: 'error', message: `Fatal: ${err}` })
      } finally {
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
