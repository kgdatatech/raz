import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { TOOLS, executeTool, ToolName } from './tools'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface AgentTask {
  taskId:      string
  repoPath:    string
  description: string
  branch:      string
}

export interface AgentEvent {
  type:    'thinking' | 'tool_call' | 'tool_result' | 'complete' | 'error'
  message: string
  data?:   Record<string, unknown>
}

export type EventCallback = (event: AgentEvent) => void

function readContextFiles(repoPath: string): string {
  const contextFiles = ['CLAUDE.md', 'AGENTS.md', 'README.md']
  const parts: string[] = []
  for (const file of contextFiles) {
    const filePath = path.join(repoPath, file)
    if (fs.existsSync(filePath)) {
      parts.push(`=== ${file} ===\n${fs.readFileSync(filePath, 'utf-8')}`)
    }
  }
  return parts.join('\n\n')
}

function setupWorktree(repoPath: string, branch: string): string {
  const worktreePath = path.join(repoPath, '..', `.raziel-worktree-${branch}`)
  try {
    // Clean up any stale worktree with the same name
    if (fs.existsSync(worktreePath)) {
      execSync(`git worktree remove --force "${worktreePath}"`, { cwd: repoPath })
    }
    execSync(`git worktree add -b "${branch}" "${worktreePath}"`, { cwd: repoPath })
    return worktreePath
  } catch (e) {
    throw new Error(`Failed to create worktree: ${e}`)
  }
}

function cleanupWorktree(repoPath: string, worktreePath: string) {
  try {
    execSync(`git worktree remove --force "${worktreePath}"`, { cwd: repoPath })
  } catch {}
}

function commitChanges(worktreePath: string, branch: string, summary: string) {
  execSync('git add -A', { cwd: worktreePath })
  const message = `feat(raziel): ${summary.slice(0, 72)}\n\nAutomated by Raziel — Archon Agent`
  execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: worktreePath })
}

export async function runAgent(task: AgentTask, onEvent: EventCallback): Promise<void> {
  const { repoPath, description, branch } = task
  let worktreePath: string | null = null

  try {
    // 1. Setup isolated worktree
    onEvent({ type: 'thinking', message: `Setting up isolated worktree on branch: ${branch}` })
    worktreePath = setupWorktree(repoPath, branch)

    // 2. Read project context (CLAUDE.md, AGENTS.md, README.md)
    const context = readContextFiles(repoPath)

    const systemPrompt = `You are Raziel, an expert software engineer working for Archon Systems.
You have been given access to a code repository and a specific task to complete.

CRITICAL SECURITY RULES — never violate these:
- Never read, write, or expose .env files, secret files, or credentials
- Never execute destructive commands (rm -rf, git reset --hard, git push --force)
- Never make network requests outside of the allowed tools
- Always work within the worktree — never reference paths outside it
- When done, call task_complete with a clear summary

WORKFLOW:
1. Read CLAUDE.md or AGENTS.md first to understand project conventions
2. Explore the repo structure to understand what exists
3. Make targeted, minimal changes to complete the task
4. Commit nothing — just complete the work, the system handles commits
5. Call task_complete when finished

PROJECT CONTEXT:
${context || 'No context files found — explore the repo structure first.'}

Your task: ${description}`

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: description },
    ]

    // 3. Agentic loop
    let iterations = 0
    const MAX_ITERATIONS = 40

    while (iterations < MAX_ITERATIONS) {
      iterations++

      const response = await anthropic.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 8096,
        system:     systemPrompt,
        tools:      TOOLS as unknown as Anthropic.Tool[],
        messages,
      })

      // Collect tool uses and text from this response
      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text')

      if (textBlocks.length > 0) {
        onEvent({ type: 'thinking', message: textBlocks.map((b) => b.text).join('\n') })
      }

      // Check for completion
      const completeCall = toolUses.find((t) => t.name === 'task_complete')
      if (completeCall) {
        const input = completeCall.input as { summary: string; files_changed: string[] }

        // Commit the work
        try {
          commitChanges(worktreePath, branch, input.summary)
          onEvent({ type: 'complete', message: input.summary, data: { files_changed: input.files_changed, branch } })
        } catch {
          onEvent({ type: 'complete', message: input.summary, data: { files_changed: input.files_changed, branch, commit_skipped: true } })
        }
        return
      }

      if (response.stop_reason === 'end_turn' && toolUses.length === 0) {
        onEvent({ type: 'complete', message: 'Agent finished without explicit completion signal.', data: { branch } })
        return
      }

      // Execute all tool calls
      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const toolUse of toolUses) {
        onEvent({
          type: 'tool_call',
          message: `${toolUse.name}`,
          data: { input: toolUse.input },
        })

        const result = await executeTool(
          toolUse.name as ToolName,
          toolUse.input as Record<string, unknown>,
          worktreePath,
        )

        onEvent({ type: 'tool_result', message: result.slice(0, 200) })

        toolResults.push({
          type:        'tool_result',
          tool_use_id: toolUse.id,
          content:     result,
        })
      }

      // Add assistant response + tool results to messages
      messages.push({ role: 'assistant', content: response.content })
      messages.push({ role: 'user', content: toolResults })
    }

    onEvent({ type: 'error', message: 'Agent exceeded maximum iterations (40). Task incomplete.' })
  } catch (err) {
    onEvent({ type: 'error', message: `Agent error: ${err}` })
  } finally {
    if (worktreePath) cleanupWorktree(repoPath, worktreePath)
  }
}
