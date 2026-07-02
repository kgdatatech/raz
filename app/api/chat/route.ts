import { NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import path from 'path'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { getRepoById, listMemoryRows, listTasks, saveChatMessage } from '@/lib/db'
import { resolveClaudeSpawn } from '@/lib/claude-bin'
import { getActiveAgentRunner } from '@/lib/agent'
import { GLOBAL_AGENT_RULES } from '@/lib/roles'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const execAsync = promisify(exec)

// ── Tool definitions for SDK mode ─────────────────────────────────────────────

const CHAT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description: 'Read a file in the repository. Blocked on .env and secret files.',
    input_schema: {
      type: 'object' as const,
      properties: { path: { type: 'string', description: 'File path relative to repo root' } },
      required: ['path'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories at a path in the repository.',
    input_schema: {
      type: 'object' as const,
      properties: { path: { type: 'string', description: 'Directory path relative to repo root. Use "." for root.' } },
      required: ['path'],
    },
  },
  {
    name: 'search_codebase',
    description: 'Search for a pattern across all files in the repository.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern:   { type: 'string', description: 'Regex or literal search pattern' },
        file_glob: { type: 'string', description: 'File glob to filter (e.g. "*.ts"). Omit to search all.' },
      },
      required: ['pattern'],
    },
  },
]

const BLOCKED_PATHS = [
  '.env', '.env.local', '.env.production', '.env.development',
  '.env.staging', '.env.test', 'secrets', '.secret', '.secrets',
  'id_rsa', 'id_ed25519', '*.pem', '*.key',
]

function isBlockedPath(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase()
  return BLOCKED_PATHS.some((b) => {
    if (b.startsWith('*')) return base.endsWith(b.slice(1))
    return base === b || base.startsWith(b + '.')
  })
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function runTool(name: string, input: Record<string, unknown>, repoPath: string): Promise<string> {
  if (name === 'read_file') {
    const rel      = input.path as string
    const filePath = path.resolve(repoPath, rel)
    if (isBlockedPath(rel)) return 'ERROR: Access to this file is blocked for security.'
    if (!isWithinRoot(repoPath, filePath)) return 'ERROR: Path traversal not allowed.'
    try { return fs.readFileSync(filePath, 'utf-8').slice(0, 8_000) }
    catch { return `ERROR: Could not read file: ${rel}` }
  }
  if (name === 'list_directory') {
    const rel     = input.path as string
    const dirPath = path.resolve(repoPath, rel)
    if (!isWithinRoot(repoPath, dirPath)) return 'ERROR: Path traversal not allowed.'
    try {
      return fs.readdirSync(dirPath, { withFileTypes: true })
        .filter((e) => !BLOCKED_PATHS.includes(e.name))
        .map((e) => `${e.isDirectory() ? '[dir] ' : '[file]'} ${e.name}`)
        .join('\n')
    } catch { return `ERROR: Could not list directory: ${rel}` }
  }
  if (name === 'search_codebase') {
    const pattern     = input.pattern as string
    const glob        = (input.file_glob as string | undefined) ?? ''
    if (/[\r\n;&|`<>]|\$\(/.test(pattern) || /[\r\n;&|`<>$()]/.test(glob)) {
      return 'ERROR: Search pattern contains unsupported shell metacharacters.'
    }
    const includeFlag = glob
      ? `--include="${glob}"`
      : '--include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.json" --include="*.md" --include="*.css"'
    const cmd = `grep -rn ${includeFlag} -C 2 ${JSON.stringify(pattern)} . 2>/dev/null | head -200`
    try {
      const { stdout } = await execAsync(cmd, { cwd: repoPath, timeout: 15_000 })
      return stdout.trim() || `No matches found for: ${pattern}`
    } catch (e: unknown) {
      const err = e as { stdout?: string }
      return err.stdout?.trim() || `No matches found for: ${pattern}`
    }
  }
  return 'ERROR: Unknown tool.'
}

// ── Shared system prompt ──────────────────────────────────────────────────────

function buildSystemPrompt(
  repo:      ReturnType<typeof getRepoById>,
  repoPath:  string | null,
  repoId:    number | null,
): string {
  let system = `You are RAZ Chat — the conversational interface for Raziel, Archon Systems' internal multi-agent coding framework.

You help the user explore their codebase, understand what RAZ agents have done, plan upcoming work, and decide which role and workflow to use. You have read-only access to the codebase via tools.

You are NOT a task executor. You don't create worktrees, branches, or PRs. Your job is to think, explore, and advise. The user dispatches tasks through the task panel after talking with you.

${GLOBAL_AGENT_RULES}

## RAZ Roles & Workflows
- **RAZ-Dev** — Features, bug fixes, refactors. Workflows: feature, fix, refactor, test, strategy, self.
- **RAZ-Sec** — Read-only security audits. Workflows: audit, strategy.
- **RAZ-QA** — Tests and coverage. Workflows: test, fix.
- **RAZ-Ops** — Build health, ops reports, strategic planning. Workflows: audit, strategy, self.
- **RAZ-Data** — DB migrations and schema. Workflows: feature, fix, refactor.

## Handoff chain
Dev → QA (test) → Ops (audit) → Sec or Dev based on findings. Runs automatically in Supervised/Autonomous modes.

## Suggesting tasks
When the user is ready to act, end your response with this exact format:

**Suggested task:** [precise, specific description]
**Role:** [RAZ-Dev | RAZ-Sec | RAZ-QA | RAZ-Ops | RAZ-Data] | **Workflow:** [feature | fix | refactor | audit | test | strategy | self]`

  if (repo) {
    system += `\n\n## Current Repository\n**${repo.github_owner}/${repo.github_repo}** · branch: \`${repo.default_branch}\``
    if (repoPath) system += `\nLocal path: \`${repoPath}\``
  }

  if (repoPath) {
    for (const f of ['AGENTS.md', 'CLAUDE.md']) {
      const fp = path.join(repoPath, f)
      if (fs.existsSync(fp)) {
        try { system += `\n\n## ${f}\n${fs.readFileSync(fp, 'utf-8').slice(0, 3_000)}` } catch {}
      }
    }
  }

  if (repoId != null) {
    const memRows = listMemoryRows(repoId)
    if (memRows.length > 0) {
      system += `\n\n## Repo Memory (from previous agent runs)\n${memRows.slice(0, 20).map((m) => `- **${m.key}:** ${m.value}`).join('\n')}`
    }
    const recentTasks = listTasks(repoId).slice(0, 8)
    if (recentTasks.length > 0) {
      system += `\n\n## Recent Tasks\n${recentTasks.map((t) => `- [${t.status}] ${t.role ?? 'RAZ-Dev'}/${t.workflow ?? 'feature'}: ${t.description.slice(0, 80)}${t.summary ? ` → ${t.summary.slice(0, 60)}` : ''}`).join('\n')}`
    }
  }

  return system
}

// ── CC runner path ────────────────────────────────────────────────────────────

async function runCCChat(
  system:    string,
  messages:  { role: 'user' | 'assistant'; content: string }[],
  repoPath:  string | null,
  repoId:    number | null,
  send:      (data: object) => void,
  signal:    AbortSignal,
): Promise<void> {
  // Build a single prompt embedding the full conversation history
  const historyLines: string[] = []
  for (const m of messages.slice(0, -1)) {
    historyLines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    historyLines.push('')
  }
  const lastMessage = messages[messages.length - 1]?.content ?? ''

  const fullPrompt = historyLines.length > 0
    ? `Previous conversation:\n\n${historyLines.join('\n')}\nUser: ${lastMessage}`
    : lastMessage

  const claudeArgs = [
    '-p', fullPrompt,
    '--system-prompt', system,
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--allowedTools', 'Read,Glob,Grep',
  ]

  const { exe, args, shell } = resolveClaudeSpawn(claudeArgs)
  const claudeProc = spawn(exe, args, {
    cwd:   repoPath ?? process.cwd(),
    env:   { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell,
  })

  if (signal.aborted) { claudeProc.kill('SIGTERM'); return }
  signal.addEventListener('abort', () => claudeProc.kill('SIGTERM'), { once: true })

  const lastMsg = messages[messages.length - 1]
  if (repoId != null && lastMsg?.role === 'user') saveChatMessage(repoId, 'user', lastMsg.content)

  let buffer  = ''
  let fullText = ''

  await new Promise<void>((resolve, reject) => {
    claudeProc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let event: Record<string, unknown>
        try { event = JSON.parse(line) as Record<string, unknown> } catch { continue }

        if (event.type === 'assistant') {
          const msg = (event.message as { content: { type: string; text?: string; name?: string; input?: unknown }[] } | undefined)
          for (const block of msg?.content ?? []) {
            if (block.type === 'text' && block.text?.trim()) {
              fullText += block.text
            }
            if (block.type === 'tool_use' && block.name) {
              const inp    = block.input as Record<string, unknown> | undefined
              const detail = inp ? (Object.values(inp)[0] as string | undefined) ?? '' : ''
              send({ type: 'tool_call', name: block.name, input: inp ?? {} })
              send({ type: 'tool_result', name: block.name, preview: String(detail).slice(0, 200) })
            }
          }
        }

        if (event.type === 'result') {
          if (fullText) send({ type: 'text', text: fullText })
          const ev = event as { is_error?: boolean; error?: string }
          if (ev.is_error) send({ type: 'error', message: ev.error ?? 'Claude Code returned an error.' })
          else             send({ type: 'done' })
        }
      }
    })

    let stderrOut = ''
    claudeProc.stderr?.on('data', (chunk: Buffer) => { stderrOut += chunk.toString() })
    claudeProc.on('error', reject)
    claudeProc.on('close', (code) => {
      if (!fullText && stderrOut) send({ type: 'error', message: `claude exited (${code ?? '?'}): ${stderrOut.slice(0, 500)}` })
      resolve()
    })
  })

  if (fullText && repoId != null) saveChatMessage(repoId, 'assistant', fullText)
  if (!fullText) send({ type: 'done' })
}

// ── SDK runner path ───────────────────────────────────────────────────────────

async function runSDKChat(
  system:    string,
  messages:  { role: 'user' | 'assistant'; content: string }[],
  repoPath:  string | null,
  repoId:    number | null,
  send:      (data: object) => void,
  signal:    AbortSignal,
): Promise<void> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const lastMsg = messages[messages.length - 1]
  if (repoId != null && lastMsg?.role === 'user') saveChatMessage(repoId, 'user', lastMsg.content)

  // Trim history before API call — full history stays in DB/UI
  const recentMessages = messages.slice(-20)
  const loopMessages: Anthropic.MessageParam[] = recentMessages.map((m) => ({
    role:    m.role as 'user' | 'assistant',
    content: m.content,
  }))

  let assistantText = ''

  for (let i = 0; i < 8; i++) {
    if (signal.aborted) break

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 8_096,
      system,
      tools:      repoPath ? CHAT_TOOLS : [],
      messages:   loopMessages,
    })

    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock    => b.type === 'text')
    const toolUses   = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')

    if (textBlocks.length > 0) {
      const text = textBlocks.map((b) => b.text).join('\n')
      assistantText += (assistantText ? '\n' : '') + text
      send({ type: 'text', text })
    }

    loopMessages.push({ role: 'assistant', content: response.content })

    if (response.stop_reason !== 'tool_use' || toolUses.length === 0 || !repoPath) break

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const tu of toolUses) {
      send({ type: 'tool_call', name: tu.name, input: tu.input })
      const result = await runTool(tu.name, tu.input as Record<string, unknown>, repoPath)
      send({ type: 'tool_result', name: tu.name, preview: result.slice(0, 200) })
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result })
    }
    loopMessages.push({ role: 'user', content: toolResults })
  }

  if (repoId != null && assistantText) saveChatMessage(repoId, 'assistant', assistantText)
  send({ type: 'done' })
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    repoId:   number | null
    messages: { role: 'user' | 'assistant'; content: string }[]
  }
  const { repoId, messages } = body

  const repo     = repoId != null ? getRepoById(repoId) : null
  const repoPath = repo?.local_path ?? null
  const system   = buildSystemPrompt(repo, repoPath, repoId)
  const runner   = getActiveAgentRunner()

  const encoder = new TextEncoder()
  const abort   = new AbortController()

  const stream = new ReadableStream({
    cancel() { abort.abort() },
    async start(controller) {
      function send(data: object): void {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)) } catch {}
      }

      const keepalive = setInterval(() => {
        try { controller.enqueue(encoder.encode(': keepalive\n\n')) } catch {}
      }, 25_000)

      try {
        if (runner === 'claude_code') {
          await runCCChat(system, messages, repoPath, repoId, send, abort.signal)
        } else if (runner === 'codex') {
          send({ type: 'error', message: 'Codex chat runner is not implemented yet. Switch to Claude SDK or Claude Code.' })
        } else {
          await runSDKChat(system, messages, repoPath, repoId, send, abort.signal)
        }
      } catch (err) {
        if (!abort.signal.aborted) send({ type: 'error', message: String(err) })
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
