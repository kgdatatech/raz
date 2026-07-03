import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'
import { execSync } from 'child_process'
import { resolveClaudeSpawn } from './claude-bin'
import { randomUUID } from 'crypto'
import {
  getIssue,
  createQueuedTask, setTaskParent, createAgentMessage, updateAgentMessageResult,
  saveSessionId, getSessionId, getPendingQuestions,
  saveWorktreePath, clearWorktreePath, STALE_WORKTREES,
  getRecentChatContext,
} from './db'
import { ROLES, DEFAULT_ROLE, type RoleId } from './roles'
import { getConfiguredModelForRole } from './models'
import type { AgentTask, AgentEvent, EventCallback } from './agent-sdk'

export type { AgentTask, AgentEvent, EventCallback }

// ── WSL helpers ───────────────────────────────────────────────────────────────
function isWslPath(p: string): boolean {
  return /^\\\\wsl(?:\.localhost|\$)\\/i.test(p)
}
function wslDistro(p: string): string {
  return p.match(/^\\\\wsl(?:\.localhost|\$)\\([^\\]+)/i)?.[1] ?? 'Ubuntu'
}
function toLinuxPath(p: string): string {
  const m = p.match(/^\\\\wsl(?:\.localhost|\$)\\[^\\]+(.+)$/i)
  return m ? m[1].replace(/\\/g, '/') : p
}
function toUncPath(distro: string, linuxPath: string): string {
  return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`
}

// ── Worktree ──────────────────────────────────────────────────────────────────
function setupWorktree(repoPath: string, branch: string, baseBranch = 'master'): string {
  const slug = `.raziel-wt-${branch.replace(/\//g, '-').slice(0, 40)}`

  if (isWslPath(repoPath)) {
    const distro    = wslDistro(repoPath)
    const linuxRepo = toLinuxPath(repoPath)
    const linuxPar  = linuxRepo.split('/').slice(0, -1).join('/')
    const linuxWt   = `${linuxPar}/${slug}`
    try {
      execSync(`wsl -d ${distro} -- git -C ${JSON.stringify(linuxRepo)} worktree remove --force ${JSON.stringify(linuxWt)}`, { stdio: 'pipe' })
    } catch {}
    try {
      execSync(`wsl -d ${distro} -- git -C ${JSON.stringify(linuxRepo)} worktree add -b ${JSON.stringify(branch)} ${JSON.stringify(linuxWt)} origin/${baseBranch}`, { stdio: 'pipe' })
    } catch {
      try {
        execSync(`wsl -d ${distro} -- git -C ${JSON.stringify(linuxRepo)} worktree add ${JSON.stringify(linuxWt)} ${JSON.stringify(branch)}`, { stdio: 'pipe' })
      } catch (e2) {
        throw new Error(`Failed to create worktree: ${e2}`)
      }
    }
    // Symlink node_modules from main repo so agents never need to npm install
    try {
      const linuxMainNm = `${linuxRepo}/node_modules`
      const linuxWtNm   = `${linuxWt}/node_modules`
      execSync(`wsl -d ${distro} -- bash -c "[ ! -e ${JSON.stringify(linuxWtNm)} ] && ln -s ${JSON.stringify(linuxMainNm)} ${JSON.stringify(linuxWtNm)} || true"`, { stdio: 'pipe' })
    } catch {}
    return toUncPath(distro, linuxWt)
  }

  const worktreePath = path.join(repoPath, '..', slug)
  if (fs.existsSync(worktreePath)) {
    try { execSync(`git worktree remove --force "${worktreePath}"`, { cwd: repoPath, stdio: 'pipe' }) } catch {}
  }
  try {
    // Preferred: create branch from origin/<baseBranch> so agent sees post-merge state.
    execSync(`git worktree add -b "${branch}" "${worktreePath}" "origin/${baseBranch}"`, { cwd: repoPath, stdio: 'pipe' })
  } catch {
    try {
      // Fallback A: origin ref not available — create from local HEAD.
      execSync(`git worktree add -b "${branch}" "${worktreePath}"`, { cwd: repoPath, stdio: 'pipe' })
    } catch {
      // Fallback B: branch already exists locally — check it out instead.
      execSync(`git worktree add "${worktreePath}" "${branch}"`, { cwd: repoPath, stdio: 'pipe' })
    }
  }

  // Junction-link node_modules from main repo so agents never need to npm install.
  // Uses junction type (no elevation required on Windows) — git worktree remove will
  // delete the junction reparse point without touching the main node_modules target.
  const mainNm = path.join(repoPath, 'node_modules')
  const wtNm   = path.join(worktreePath, 'node_modules')
  if (fs.existsSync(mainNm) && !fs.existsSync(wtNm)) {
    try { fs.symlinkSync(mainNm, wtNm, 'junction') } catch {}
  }

  return worktreePath
}

function cleanupWorktree(repoPath: string, worktreePath: string) {
  try {
    if (isWslPath(repoPath)) {
      const distro = wslDistro(repoPath)
      execSync(`wsl -d ${distro} -- git -C ${JSON.stringify(toLinuxPath(repoPath))} worktree remove --force ${JSON.stringify(toLinuxPath(worktreePath))}`, { stdio: 'pipe' })
    } else {
      // Remove the node_modules junction before git removes the worktree.
      // 'git worktree remove --force' uses recursive deletion on Windows and could follow
      // the junction into the main repo's node_modules — rmdir removes only the junction point.
      const nmJunction = path.join(worktreePath, 'node_modules')
      try {
        if (fs.existsSync(nmJunction) && fs.lstatSync(nmJunction).isSymbolicLink()) {
          fs.rmdirSync(nmJunction)
        }
      } catch {}
      execSync(`git worktree remove --force "${worktreePath}"`, { cwd: repoPath, stdio: 'pipe' })
    }
  } catch {}
}

function commitChanges(worktreePath: string, summary: string, workflow: string, commitPrefix: string) {
  const type    = workflow === 'fix' ? 'fix' : workflow === 'refactor' ? 'refactor' : workflow === 'audit' ? 'chore' : 'feat'
  const message = `${type}(${commitPrefix}): ${summary.slice(0, 72)}\n\nAutomated by RAZ — Archon Systems`

  if (isWslPath(worktreePath)) {
    const distro   = wslDistro(worktreePath)
    const linuxWt  = toLinuxPath(worktreePath)
    const msgB64   = Buffer.from(message, 'utf-8').toString('base64')
    const innerCmd = `cd ${JSON.stringify(linuxWt)} && git add -A && printf '%s' '${msgB64}' | base64 -d | git commit -F -`
    execSync(`wsl -d ${distro} -- bash -c ${JSON.stringify(innerCmd)}`, { stdio: 'pipe' })
  } else {
    execSync('git add -A', { cwd: worktreePath, stdio: 'pipe' })
    execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: worktreePath, stdio: 'pipe' })
  }
}

// ── Rate limit detection ──────────────────────────────────────────────────────
function isRateLimitError(msg: string): boolean {
  return /rate.?limit|usage.?limit|too many request|quota exceeded|claude\.ai\/upgrade/i.test(msg)
}

function parseRateLimitReset(msg: string): string {
  const minuteMatch = msg.match(/(\d+)\s*minute/i)
  if (minuteMatch) return new Date(Date.now() + parseInt(minuteMatch[1]) * 60_000).toISOString()
  const secondMatch = msg.match(/(\d+)\s*second/i)
  if (secondMatch) return new Date(Date.now() + parseInt(secondMatch[1]) * 1_000).toISOString()
  const hourMatch = msg.match(/(\d+)\s*hour/i)
  if (hourMatch) return new Date(Date.now() + parseInt(hourMatch[1]) * 3_600_000).toISOString()
  // Default: 1 hour
  return new Date(Date.now() + 3_600_000).toISOString()
}

// ── System prompt ─────────────────────────────────────────────────────────────
function buildSystemPrompt(params: {
  workflow:     string
  roleContext:  string
  issueContent?: string
  parentRole?:  string
  chatContext?:  string
}): string {
  const { workflow, roleContext, issueContent, parentRole, chatContext } = params

  // Memory and history are loaded via mcp__raz__get_memory at runtime — not injected here
  // This keeps the --system-prompt arg small regardless of how much memory accumulates
  const memoryBlock  = ''
  const historyBlock = ''

  const issueBlock      = issueContent ? `\n\nLINKED GITHUB ISSUE:\n${issueContent}` : ''
  const delegationBlock = parentRole   ? `\n\n⚡ DELEGATED TASK: You were called by ${parentRole}. Complete your task and call mcp__raz__task_complete with a clear summary.` : ''
  const chatBlock       = chatContext  ? `\n\n══════════════════════════════════════\nPRE-TASK CHAT CONTEXT\n══════════════════════════════════════\nRecent conversation with the user before this task was dispatched. Use it to understand intent and background.\n\n${chatContext}` : ''

  const workflowGuide: Record<string, string> = {
    feature:  'You are implementing a new feature. Plan thoroughly. Write clean, typed code. No placeholders.',
    fix:      'You are fixing a bug. Diagnose root cause first. Write minimal, targeted changes.',
    refactor: 'You are improving existing code. Do not change behavior. Clean up, extract, rename, simplify.',
    audit:    'You are performing a security and code quality audit. Read widely, identify issues, write a detailed report.',
    strategy: 'You are researching and strategizing. Read the codebase and produce a detailed written plan.',
    test:     'You are writing or improving tests. Understand what exists, identify gaps, write comprehensive test cases.',
    self:     'You are improving the RAZ agent system itself. Read lib/agent-cc.ts, lib/mcp-server.ts, lib/db.ts, and app/page.tsx thoroughly. Identify capability gaps, bugs, UX issues, and missing features. Use mcp__raz__generate_report for findings. For UI and API changes, implement directly. SAFETY GATE: before editing lib/agent-cc.ts, lib/mcp-server.ts, or lib/db.ts, call mcp__raz__ask_user to get explicit approval first.',
  }

  return `${roleContext}

You work on real production codebases. You are methodical, thorough, and security-obsessed.

MEMORY-FIRST RULE: Call mcp__raz__get_memory as your FIRST action. Use what prior agents discovered before reading any files. Only read files when memory is insufficient — this prevents redundant work and saves tokens.

══════════════════════════════════════
ARCHON SYSTEMS CONTEXT
══════════════════════════════════════
Active projects: Kairos (crypto signals), Chronos (trading dashboard), Augur (ML predictor),
PhantomTag (VST monitoring), Argos (SMB data platform), Primordial (neural sim), archon-base (template).
Stack: Next.js App Router · TypeScript · Tailwind · Supabase · Vercel · better-sqlite3

══════════════════════════════════════
CURRENT WORKFLOW: ${workflow.toUpperCase()}
══════════════════════════════════════
${workflowGuide[workflow] ?? workflowGuide.feature}

══════════════════════════════════════
MANDATORY PHASE ORDER
══════════════════════════════════════
0. MEMORY      → Call mcp__raz__get_memory FIRST. Always. It loads everything known about this repo.
1. PLAN        → Call mcp__raz__create_plan before any writes. No exceptions.
2. EXPLORE     → Use the allowed file/search tools. Read CLAUDE.md and AGENTS.md first.
               → After every significant read: call mcp__raz__save_memory immediately.
3. IMPLEMENT   → Make targeted, minimal changes inside the worktree.
4. VERIFY      → Run the configured build. Fix every error.
5. TEST        → Run the test suite. Fix failures.
6. LINT        → Run lint. Fix errors.
7. SECURITY    → Call mcp__raz__security_scan on every changed file.
8. COMPLETE    → Call mcp__raz__task_complete with summary and files list.

══════════════════════════════════════
MCP TOOLS (RAZ-specific)
══════════════════════════════════════
mcp__raz__get_memory         — load all repo memory + task history (call first, always)
mcp__raz__ask_user           — ask the user a question and wait for their answer (blocks until they respond)
mcp__raz__create_plan        — save your plan (required before any writes)
mcp__raz__save_memory        — persist a finding to the repo memory bank
mcp__raz__task_complete      — signal completion with summary + files changed
mcp__raz__security_scan      — scan files for secrets before completing
mcp__raz__generate_report    — save a structured markdown report (audits/assessments)
mcp__raz__delegate_to_role   — run a specialist sub-agent right now, wait for result
mcp__raz__handoff_to_role    — queue a follow-up task for another role (you don't wait)
mcp__raz__fetch_issue        — fetch a GitHub issue by number
mcp__raz__list_open_issues   — list open GitHub issues

TOOLS
Use only the allowed tools and stay inside the provided worktree.

══════════════════════════════════════
WHEN TO ASK THE USER
══════════════════════════════════════
If you need a decision only the user can make (e.g. framework choice, business rule, which approach to take),
call mcp__raz__ask_user BEFORE proceeding. Do NOT guess and proceed — block and wait for the answer.
The UI will present your question interactively. You will receive the user's response as the tool result.

══════════════════════════════════════
SECURITY RULES — ABSOLUTE
══════════════════════════════════════
• Never read, write, or reference .env files or secrets
• Never run: rm -rf, git reset --hard, git push --force, DROP TABLE, DELETE without WHERE
• Always call mcp__raz__security_scan before mcp__raz__task_complete
• Work only within the provided worktree directory

══════════════════════════════════════
CODE QUALITY
══════════════════════════════════════
• Read CLAUDE.md / AGENTS.md first — project rules override general guidance
• TypeScript: no "any", explicit return types on exports
• No console.log in production code
• Conventional commits: feat:, fix:, refactor:, chore:, test:, docs:
${memoryBlock}${historyBlock}${issueBlock}${chatBlock}${delegationBlock}`
}

// ── MCP config ────────────────────────────────────────────────────────────────
function writeMcpConfig(worktreePath: string, mcpEnv: Record<string, string>): string {
  const mcpServerPath = path.resolve(process.cwd(), 'lib', 'mcp-server.ts')
  const tsxCli        = path.resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const configPath    = path.join(os.tmpdir(), `raz-mcp-${randomUUID()}.json`)
  const config = {
    mcpServers: {
      raz: {
        command: process.execPath,   // absolute path to the node binary running Next.js
        args:    [tsxCli, mcpServerPath],
        env:     mcpEnv,
      },
    },
  }
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')
  return configPath
}

// ── stream-json types ─────────────────────────────────────────────────────────
interface CCInitEvent   { type: 'system';    subtype: 'init'; session_id: string }
interface CCAssistEvent { type: 'assistant'; message: { content: CCBlock[]; usage?: { input_tokens: number; output_tokens: number } } }
interface CCResultEvent { type: 'result';    subtype: string; result?: string; is_error?: boolean; error?: string; total_cost_usd?: number; session_id?: string }
type CCEvent  = CCInitEvent | CCAssistEvent | { type: 'user' } | CCResultEvent
interface CCTextBlock    { type: 'text';     text: string }
interface CCToolUseBlock { type: 'tool_use'; name: string; input: Record<string, unknown> }
type CCBlock = CCTextBlock | CCToolUseBlock

// ── Stale worktree cleanup ────────────────────────────────────────────────────
const AGENT_TIMEOUT_MS = 45 * 60 * 1_000

let staleWorktreesHandled = false
function cleanupStaleWorktrees() {
  if (staleWorktreesHandled) return
  staleWorktreesHandled = true
  for (const row of STALE_WORKTREES) {
    if (!row.repo_path || !row.worktree_path) continue
    try { cleanupWorktree(row.repo_path, row.worktree_path) } catch {}
    try { clearWorktreePath(row.id) } catch {}
  }
}

// ── Main agent loop ───────────────────────────────────────────────────────────
export async function runAgent(task: AgentTask, onEvent: EventCallback, signal?: AbortSignal): Promise<void> {
  const {
    taskId, repoPath, description, branch, workflow,
    role, repoId, issueNumber, github, parentRole, existingWorktree, runner,
    baseBranch = 'master',
  } = task

  const roleDefinition = ROLES[role ?? DEFAULT_ROLE]
  const isSubAgent     = !!existingWorktree
  let worktreePath: string | null = existingWorktree ?? null
  let mcpConfigPath: string | null = null

  cleanupStaleWorktrees()

  try {
    if (existingWorktree) {
      onEvent({ type: 'thinking', message: `[sub-agent] Starting in parent worktree: ${path.basename(existingWorktree)}` })
    } else {
      onEvent({ type: 'thinking', message: `Initializing worktree on branch: ${branch}` })
      worktreePath = setupWorktree(repoPath, branch, baseBranch)
      saveWorktreePath(taskId, worktreePath)
    }

    let issueContent: string | undefined
    if (issueNumber && repoId) {
      const cached = getIssue(repoId, issueNumber)
      if (cached) issueContent = `#${cached.number}: ${cached.title}\n\n${cached.body ?? ''}`
    }

    const chatContext  = repoId ? getRecentChatContext(repoId) : ''
    const systemPrompt = buildSystemPrompt({ workflow, roleContext: roleDefinition.systemContext, issueContent, parentRole, chatContext: chatContext || undefined })

    // Claude Code still needs its built-ins because the MCP server currently
    // hosts RAZ lifecycle tools, not the SDK file tools. Permission bypass is
    // deliberately disabled below.
    const builtinMap: Record<string, string> = {
      read_file:          'Read',
      write_file:         'Write',
      execute_bash:       'Bash',
      list_directory:     'Glob',
      search_codebase:    'Grep',
      get_diff:           'Bash',
      run_build:          'Bash',
      run_tests:          'Bash',
      run_lint:           'Bash',
      dependency_audit:   'Bash',
      check_coverage:     'Bash',
      validate_migration: 'Bash',
    }
    const commonMcpTools = [
      'mcp__raz__get_memory', 'mcp__raz__get_role_context',
      'mcp__raz__ask_user',
      'mcp__raz__create_plan', 'mcp__raz__save_memory', 'mcp__raz__task_complete',
      'mcp__raz__delegate_to_role', 'mcp__raz__handoff_to_role',
    ]
    const roleMcpTools = roleDefinition.allowedTools.map((tool) => `mcp__raz__${tool}`)
    const allowedBuiltins = roleDefinition.allowedTools.map((tool) => builtinMap[tool]).filter(Boolean)
    const allowedTools = [...new Set([...allowedBuiltins, ...commonMcpTools, ...roleMcpTools])].join(',')

    const dbPath = process.env.RAZ_DB_PATH ?? path.join(process.cwd(), '.raziel', 'raziel.db')

    const mcpEnv: Record<string, string> = {
      RAZ_TASK_ID:  taskId,
      RAZ_WORKTREE: worktreePath!,
      RAZ_DB_PATH:  dbPath,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? '',
      ...(repoId        ? { RAZ_REPO_ID:      String(repoId) }  : {}),
      ...(github?.owner ? { RAZ_GITHUB_OWNER: github.owner }    : {}),
      ...(github?.repo  ? { RAZ_GITHUB_REPO:  github.repo }     : {}),
      ...(role          ? { RAZ_PARENT_ROLE:   role }            : {}),
      ...(role          ? { RAZ_ROLE:          role }            : {}),
    }

    mcpConfigPath = writeMcpConfig(worktreePath!, mcpEnv)

    // Check for saved session to resume
    const savedSession = getSessionId(taskId)
    const taskPrompt   = `Task: ${description}${issueNumber ? `\n\nLinked issue: #${issueNumber}` : ''}${isWslPath(worktreePath!) ? `\n\nWorking directory: ${worktreePath}` : ''}`

    // Only pass --model when explicitly configured — otherwise the user's
    // Claude Code CLI default (set via /model) stays in control.
    const configuredModel = getConfiguredModelForRole(role)
    const modelArgs       = configuredModel ? ['--model', configuredModel] : []

    const claudeArgs = savedSession
      ? ['--resume', savedSession, '-p', 'Continue from where you left off. Review what was already done and proceed with remaining steps.', '--output-format', 'stream-json', '--verbose', '--allowedTools', allowedTools, '--mcp-config', mcpConfigPath, ...modelArgs]
      : ['-p', taskPrompt, '--system-prompt', systemPrompt, '--output-format', 'stream-json', '--verbose', '--allowedTools', allowedTools, '--mcp-config', mcpConfigPath, ...modelArgs]

    const { exe, args, shell } = resolveClaudeSpawn(claudeArgs)
    const {
      GITHUB_TOKEN: _githubToken,
      GITHUB_PAT: _githubPat,
      RAZ_CONFIG_TOKEN: _configToken,
      ...agentEnv
    } = process.env
    void _githubToken
    void _githubPat
    void _configToken
    const claudeProc = spawn(exe, args, {
      cwd:   isWslPath(worktreePath!) ? undefined : worktreePath!,
      env:   agentEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell,
    })

    if (signal) {
      signal.addEventListener('abort', () => claudeProc.kill('SIGTERM'), { once: true })
    }

    const timeoutHandle = setTimeout(() => {
      claudeProc.kill('SIGTERM')
      onEvent({ type: 'error', message: `Agent timed out after 45 minutes — process killed.` })
    }, AGENT_TIMEOUT_MS)

    // ── Parse stream-json output ──────────────────────────────────────────────
    let buffer         = ''
    let completionData: { summary: string; files_changed: string[]; notes?: string | null } | null = null

    const processLine = (line: string) => {
      if (!line.trim()) return
      let event: CCEvent
      try { event = JSON.parse(line) } catch { return }

      if (event.type === 'system' && (event as CCInitEvent).subtype === 'init') {
        saveSessionId(taskId, (event as CCInitEvent).session_id)
      }

      if (event.type === 'assistant') {
        const { content, usage } = (event as CCAssistEvent).message
        for (const block of content) {
          if (block.type === 'text' && block.text.trim()) {
            onEvent({ type: 'thinking', message: block.text })
          }
          if (block.type === 'tool_use') {
            onEvent({ type: 'tool_call', message: block.name, data: { input: block.input } })
            if (block.name === 'mcp__raz__create_plan') {
              onEvent({ type: 'plan', message: String(block.input.plan ?? '') })
            }
            if (block.name === 'mcp__raz__delegate_to_role') {
              onEvent({ type: 'delegation', message: `→ ${block.input.role}: ${String(block.input.description ?? '').slice(0, 100)}`, data: { subRole: block.input.role, isDelegation: true } })
            }
            if (block.name === 'mcp__raz__handoff_to_role') {
              onEvent({ type: 'handoff', message: `⟶ ${block.input.role}: ${String(block.input.description ?? '').slice(0, 80)}`, data: { role: block.input.role, description: block.input.description } })
            }
          }
        }
        if (usage) {
          onEvent({ type: 'usage', message: 'CC subscription', data: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } })
        }
      }

      if (event.type === 'result') {
        const ev = event as CCResultEvent
        if (ev.total_cost_usd !== undefined) {
          onEvent({ type: 'usage', message: 'CC subscription', data: { costUsd: ev.total_cost_usd } })
        }

        const markerPath = path.join(worktreePath!, '.raziel-completion.json')
        if (fs.existsSync(markerPath)) {
          try { completionData = JSON.parse(fs.readFileSync(markerPath, 'utf-8')); fs.unlinkSync(markerPath) } catch {}
        }

        if (ev.is_error) {
          const errMsg = ev.error ?? 'Claude Code returned an error.'
          if (isRateLimitError(errMsg)) {
            onEvent({ type: 'error', message: `Rate limit reached. ${errMsg}`, data: { rateLimited: true, resetAt: parseRateLimitReset(errMsg) } })
          } else {
            onEvent({ type: 'error', message: errMsg })
          }
          return
        }

        if (completionData) {
          if (!isSubAgent) {
            try { commitChanges(worktreePath!, completionData.summary, workflow, roleDefinition.commitPrefix) } catch {}
          }
          onEvent({ type: 'complete', message: completionData.summary, data: { files_changed: completionData.files_changed, notes: completionData.notes, branch, isSubAgent } })
        } else {
          onEvent({ type: 'error', message: 'Claude Code finished without calling task_complete.' })
        }
      }
    }

    // ── Delegation polling ────────────────────────────────────────────────────
    const delegationPoller = setInterval(async () => {
      const delegatePath = path.join(worktreePath!, '.raziel-delegate.json')
      if (!fs.existsSync(delegatePath)) return

      let req: { role: string; description: string; workflow?: string }
      try { req = JSON.parse(fs.readFileSync(delegatePath, 'utf-8')); fs.unlinkSync(delegatePath) } catch { return }

      const subRole   = req.role as RoleId
      const subTaskId = randomUUID()
      const subWf     = req.workflow ?? (subRole === 'RAZ-Sec' ? 'audit' : subRole === 'RAZ-QA' ? 'test' : subRole === 'RAZ-Ops' ? 'strategy' : 'feature')

      if (repoId) {
        const { createTask } = await import('./db')
        createTask(subTaskId, repoId, req.description, branch, subWf, undefined, subRole, runner ?? 'claude_code')
        setTaskParent(subTaskId, taskId)
      }
      const msgId = repoId ? createAgentMessage({ repoId, fromRole: role ?? DEFAULT_ROLE, toRole: subRole, fromTaskId: taskId, toTaskId: subTaskId, messageType: 'delegation', message: req.description }) : undefined

      let subSummary = 'Sub-agent completed.'; let subFailed = false

      await runAgent(
        { taskId: subTaskId, repoPath, description: req.description, branch, workflow: subWf, role: subRole, repoId, github, existingWorktree: worktreePath!, parentTaskId: taskId, parentRole: role, maxIterations: 20, runner: runner ?? 'claude_code' },
        (ev) => {
          onEvent({ ...ev, message: `[${subRole}] ${ev.message}`, data: { ...ev.data, delegated: true, delegateRole: subRole } })
          if (ev.type === 'complete') subSummary = ev.message
          if (ev.type === 'error') { subFailed = true; subSummary = ev.message }
        },
        signal,
      )

      if (repoId && msgId !== undefined) updateAgentMessageResult(msgId, subFailed ? `FAILED: ${subSummary}` : subSummary)

      const resultPath = path.join(worktreePath!, '.raziel-delegate-result.json')
      fs.writeFileSync(resultPath, JSON.stringify({ summary: subSummary, failed: subFailed }), 'utf-8')
      onEvent({ type: 'delegation', message: `← ${subRole} ${subFailed ? 'failed' : 'complete'}: ${subSummary.slice(0, 100)}`, data: { subRole, subTaskId, complete: true, failed: subFailed } })
    }, 500)

    // ── Handoff poller — process handoffs as soon as the file appears ────────
    const handoffPoller = setInterval(() => { processHandoffs() }, 2_000)

    // ── Question poller — surface ask_user questions to the UI ───────────────
    const emittedQuestions = new Set<string>()
    const questionPoller = setInterval(() => {
      const pending = getPendingQuestions(taskId)
      for (const q of pending) {
        if (emittedQuestions.has(q.id)) continue
        emittedQuestions.add(q.id)
        onEvent({
          type:    'ask_user',
          message: q.question,
          data: {
            questionId: q.id,
            question:   q.question,
            options:    q.options ? JSON.parse(q.options) : undefined,
            inputType:  q.input_type,
          },
        })
      }
    }, 500)

    // ── Handoff processing from result ────────────────────────────────────────
    // Sub-agents share the parent's worktree and never own their own PR lifecycle,
    // so they cannot create handoff tasks. Only the main (non-sub) agent creates them,
    // and they start as 'pending' — route.ts activates them after the PR is merged
    // so the follow-on agent always branches from a fully-synced origin.
    const processHandoffs = () => {
      if (isSubAgent) return
      const handoffPath = path.join(worktreePath!, '.raziel-handoff.json')
      if (!fs.existsSync(handoffPath)) return
      try {
        const handoffs = JSON.parse(fs.readFileSync(handoffPath, 'utf-8')) as { role: string; description: string; context?: string; workflow?: string }[]
        fs.unlinkSync(handoffPath)
        for (const h of handoffs) {
          if (!repoId) continue
          const newId      = randomUUID()
          const toRole     = h.role as RoleId
          const toWf       = h.workflow ?? (toRole === 'RAZ-Sec' ? 'audit' : toRole === 'RAZ-QA' ? 'test' : toRole === 'RAZ-Ops' ? 'strategy' : 'feature')
          const branchSlug = h.description.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 25).replace(/-$/, '')
          const newBranch  = `${toRole.toLowerCase().replace('-', '')}/handoff-${branchSlug}-${newId.slice(0, 6)}`
          const fullDesc   = h.context ? `${h.description}\n\nContext:\n${h.context}` : h.description
          createQueuedTask(newId, repoId, fullDesc, newBranch, toWf, toRole, taskId, 'pending')
          createAgentMessage({ repoId, fromRole: role ?? DEFAULT_ROLE, toRole, fromTaskId: taskId, toTaskId: newId, messageType: 'handoff', message: h.description, context: h.context })
          onEvent({ type: 'handoff', message: `⟶ ${toRole}: ${h.description.slice(0, 80)}`, data: { taskId: newId, role: toRole, description: fullDesc, workflow: toWf, branch: newBranch } })
        }
      } catch {}
    }

    // ── Stream stdout ─────────────────────────────────────────────────────────
    claudeProc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) processLine(line)
    })

    claudeProc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim()
      if (!text) return
      if (isRateLimitError(text)) {
        onEvent({ type: 'error', message: `Rate limit reached. ${text}`, data: { rateLimited: true, resetAt: parseRateLimitReset(text) } })
      } else {
        onEvent({ type: 'thinking', message: `[stderr] ${text}` })
      }
    })

    await new Promise<void>((resolve) => {
      claudeProc.on('close', () => {
        clearTimeout(timeoutHandle)
        clearInterval(delegationPoller)
        clearInterval(questionPoller)
        clearInterval(handoffPoller)
        if (buffer.trim()) processLine(buffer)
        processHandoffs()
        resolve()
      })
    })

  } catch (err) {
    const errMsg = String(err)
    if (errMsg.includes('ENOENT') && errMsg.includes('claude')) {
      onEvent({ type: 'error', message: 'Claude Code CLI not found in PATH. Install it and ensure `claude` is accessible from this terminal.' })
    } else {
      onEvent({ type: 'error', message: `Agent error: ${err}` })
    }
  } finally {
    if (mcpConfigPath) try { fs.unlinkSync(mcpConfigPath) } catch {}
    if (worktreePath && !isSubAgent) {
      cleanupWorktree(repoPath, worktreePath)
      clearWorktreePath(taskId)
    }
  }
}
