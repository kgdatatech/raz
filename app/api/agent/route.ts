import { NextRequest } from 'next/server'
import { randomUUID } from 'crypto'
import { runAgent } from '@/lib/agent'
import { pushBranchAndOpenPR } from '@/lib/github'

export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  const { repoPath, owner, repo, baseBranch, description } = await req.json()

  if (!repoPath || !owner || !repo || !description) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400 })
  }

  const taskId  = randomUUID()
  const branch  = `raziel/${taskId.slice(0, 8)}`

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      function send(data: object) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      }

      try {
        let completionData: Record<string, unknown> | undefined

        await runAgent(
          { taskId, repoPath, description, branch },
          (event) => {
            send(event)
            if (event.type === 'complete') completionData = event.data
          },
        )

        // Push branch and open PR
        if (completionData && !completionData.commit_skipped) {
          send({ type: 'thinking', message: 'Opening pull request on GitHub...' })
          try {
            const prUrl = await pushBranchAndOpenPR({
              repoPath,
              owner,
              repo,
              branch,
              baseBranch: baseBranch ?? 'main',
              title:      `[Raziel] ${description.slice(0, 60)}`,
              body:       `## Raziel Agent Task\n\n**Task:** ${description}\n\n**Summary:** ${completionData.summary ?? ''}\n\n**Files changed:**\n${((completionData.files_changed as string[]) ?? []).map((f: string) => `- \`${f}\``).join('\n')}\n\n---\n> Automated by Raziel · Archon Systems\n> Review carefully before merging.`,
            })
            send({ type: 'complete', message: 'PR opened successfully.', data: { prUrl, branch } })
          } catch (e) {
            send({ type: 'error', message: `Task complete but PR failed: ${e}. Branch: ${branch}` })
          }
        }
      } catch (err) {
        send({ type: 'error', message: `Fatal error: ${err}` })
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
