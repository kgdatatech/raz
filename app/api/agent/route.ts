import { NextRequest } from 'next/server'
import { randomUUID } from 'crypto'
import { runAgent } from '@/lib/agent'
import { pushBranchAndOpenPR } from '@/lib/github'
import { getRepo, upsertRepo, createTask, completeTask, failTask } from '@/lib/db'
import { type RoleId, DEFAULT_ROLE, ROLE_IDS } from '@/lib/roles'

export const runtime    = 'nodejs'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  const { owner, repo, description, workflow = 'feature', issueNumber, role: rawRole } = await req.json()
  const role: RoleId = ROLE_IDS.includes(rawRole) ? rawRole : DEFAULT_ROLE

  if (!owner || !repo || !description) {
    return new Response(JSON.stringify({ error: 'Missing required fields: owner, repo, description' }), { status: 400 })
  }

  const repoRow = getRepo(owner, repo)
  if (!repoRow?.local_path) {
    return new Response(JSON.stringify({ error: 'Local path not configured for this repo.' }), { status: 400 })
  }

  const taskId    = randomUUID()
  const taskSlug  = description.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30).replace(/-$/, '')
  const roleSlug  = role.toLowerCase().replace('-', '-')  // e.g. raz-dev
  const branch    = `${roleSlug}/${taskSlug}-${taskId.slice(0, 6)}`
  const repoPath  = repoRow.local_path
  const baseBranch = repoRow.default_branch

  upsertRepo(owner, repo, baseBranch, repoPath)
  createTask(taskId, repoRow.id, description, branch, workflow, issueNumber, role)

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
            repoId:      repoRow.id,
            issueNumber,
            github:      { owner, repo },
          },
          (event) => {
            send(event)
            if (event.type === 'complete') completionData = { ...event.data, summary: event.message }
          },
          abort.signal,
        )

        if (completionData && !completionData.commit_skipped) {
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
        } else if (completionData?.commit_skipped) {
          completeTask(taskId, null, String(completionData.summary ?? ''), [])
        }
      } catch (err) {
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
