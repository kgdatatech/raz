import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { randomUUID } from 'crypto'
import { TOOLS, executeTool, ToolName, ToolContext } from './tools'
import {
  getMemory, listTasks, getIssue, saveTaskMessages,
  createQueuedTask, setTaskParent, createAgentMessage, updateAgentMessageResult,
} from './db'
import { ROLES, DEFAULT_ROLE, type RoleId } from './roles'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface AgentTask {
  taskId:              string
  repoPath:            string
  description:         string
  branch:              string
  workflow:            string
  role?:               RoleId
  repoId?:             number
  issueNumber?:        number
  github?:             { owner: string; repo: string }
  checkpointMessages?: unknown[]
  parentTaskId?:       string
  parentRole?:         string
  maxIterations?:      number
  existingWorktree?:   string  // when set, skip worktree creation (used by sub-agents)
}

export interface AgentEvent {
  type:    'thinking' | 'tool_call' | 'tool_result' | 'plan' | 'usage' | 'complete' | 'error' | 'delegation' | 'handoff'
  message: string
  data?:   Record<string, unknown>
}

export type EventCallback = (event: AgentEvent) => void

// ── WSL path helpers ──────────────────────────────────────────────────────────
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
function setupWorktree(repoPath: string, branch: string): string {
  const slug = `.raziel-worktree-${branch.replace(/\//g, '-')}`

  if (isWslPath(repoPath)) {
    const distro    = wslDistro(repoPath)
    const linuxRepo = toLinuxPath(repoPath)
    const linuxPar  = linuxRepo.split('/').slice(0, -1).join('/')
    const linuxWt   = `${linuxPar}/${slug}`
    try {
      execSync(
        `wsl -d ${distro} -- git -C ${JSON.stringify(linuxRepo)} worktree remove --force ${JSON.stringify(linuxWt)}`,
        { stdio: 'pipe' },
      )
    } catch {}
    try {
      execSync(
        `wsl -d ${distro} -- git -C ${JSON.stringify(linuxRepo)} worktree add -b ${JSON.stringify(branch)} ${JSON.stringify(linuxWt)}`,
        { stdio: 'pipe' },
      )
    } catch {
      try {
        execSync(
          `wsl -d ${distro} -- git -C ${JSON.stringify(linuxRepo)} worktree add ${JSON.stringify(linuxWt)} ${JSON.stringify(branch)}`,
          { stdio: 'pipe' },
        )
      } catch (e2) {
        throw new Error(`Failed to create worktree: ${e2}`)
      }
    }
    return toUncPath(distro, linuxWt)
  }

  const worktreePath = path.join(repoPath, '..', slug)
  try {
    if (fs.existsSync(worktreePath)) {
      execSync(`git worktree remove --force "${worktreePath}"`, { cwd: repoPath, stdio: 'pipe' })
    }
    try {
      execSync(`git worktree add -b "${branch}" "${worktreePath}"`, { cwd: repoPath, stdio: 'pipe' })
    } catch {
      execSync(`git worktree add "${worktreePath}" "${branch}"`, { cwd: repoPath, stdio: 'pipe' })
    }
    return worktreePath
  } catch (e) {
    throw new Error(`Failed to create worktree: ${e}`)
  }
}

function cleanupWorktree(repoPath: string, worktreePath: string) {
  try {
    if (isWslPath(repoPath)) {
      const distro    = wslDistro(repoPath)
      const linuxRepo = toLinuxPath(repoPath)
      const linuxWt   = toLinuxPath(worktreePath)
      execSync(
        `wsl -d ${distro} -- git -C ${JSON.stringify(linuxRepo)} worktree remove --force ${JSON.stringify(linuxWt)}`,
        { stdio: 'pipe' },
      )
    } else {
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

// ── Rate-limit backoff ────────────────────────────────────────────────────────
async function callWithBackoff(
  fn:       () => Promise<Anthropic.Message>,
  onRetry:  (attempt: number, delayMs: number) => void,
  signal?:  AbortSignal,
  maxRetries = 5,
): Promise<Anthropic.Message> {
  for (let i = 0; i < maxRetries; i++) {
    if (signal?.aborted) throw new Error('Task cancelled.')
    try {
      return await fn()
    } catch (e: unknown) {
      const err       = e as { status?: number }
      const retryable = err.status === 429 || err.status === 529 || (err.status ?? 0) >= 500
      if (!retryable || i === maxRetries - 1) throw e
      const delay = Math.min(2_000 * Math.pow(2, i), 60_000)
      onRetry(i + 1, delay)
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delay)
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Task cancelled.')) }, { once: true })
      })
    }
  }
  throw new Error('Max retries exceeded')
}

// ── Context files ─────────────────────────────────────────────────────────────
function readContextFiles(repoPath: string): string {
  const files = ['CLAUDE.md', 'AGENTS.md', 'README.md', '.raziel/context.md']
  const parts: string[] = []
  for (const file of files) {
    const p = path.join(repoPath, file)
    if (fs.existsSync(p)) parts.push(`=== ${file} ===\n${fs.readFileSync(p, 'utf-8')}`)
  }
  return parts.join('\n\n')
}

// ── System prompt ─────────────────────────────────────────────────────────────
function buildSystemPrompt(params: {
  context:       string
  memory:        Record<string, string>
  pastTasks:     ReturnType<typeof listTasks>
  workflow:      string
  roleContext:   string
  issueContent?: string
  isResume:      boolean
  parentRole?:   string
}): string {
  const { context, memory, pastTasks, workflow, roleContext, issueContent, isResume, parentRole } = params

  const memoryBlock = Object.keys(memory).length > 0
    ? `\n\nREPO MEMORY (what you know about this codebase):\n${Object.entries(memory).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`
    : ''

  const historyBlock = pastTasks.length > 0
    ? `\n\nRECENT TASK HISTORY (last ${pastTasks.length} tasks on this repo):\n${pastTasks.map((t) => `- [${t.status}] [${t.workflow ?? 'feature'}] ${t.description}${t.summary ? ` → ${t.summary}` : ''}`).join('\n')}`
    : ''

  const issueBlock = issueContent
    ? `\n\nLINKED GITHUB ISSUE:\n${issueContent}`
    : ''

  const resumeBlock = isResume
    ? `\n\n⚠ RESUMED TASK: This task was interrupted and is continuing from a saved checkpoint. Review the conversation history above to understand what was already done, then continue from where you left off. Do NOT repeat work already completed.`
    : ''

  const delegationBlock = parentRole
    ? `\n\n⚡ DELEGATED TASK: You were called by ${parentRole}. Complete your task and call task_complete with a clear summary — your findings will be returned to the parent agent as a tool result.`
    : ''

  const workflowGuide: Record<string, string> = {
    feature:  'You are implementing a new feature. Plan it thoroughly. Write clean, typed code. No placeholders.',
    fix:      'You are fixing a bug. Diagnose root cause first. Write minimal, targeted changes. Add a test if a test suite exists.',
    refactor: 'You are improving existing code. Do not change behavior. Clean up, extract, rename, simplify. Run tests after.',
    audit:    'You are performing a security and code quality audit. Read widely, identify issues, write a detailed report, and fix what you can safely fix.',
    strategy: 'You are researching and strategizing. Read the codebase, understand the problem space, and produce a detailed written plan. You may create or update docs but should not make code changes.',
    test:     'You are writing or improving tests. Understand what exists, identify gaps, write comprehensive test cases, run them to confirm they pass.',
  }

  return `${roleContext}

You work on real production codebases. You are methodical, thorough, and security-obsessed.
You think before you act and always verify your work before declaring it complete.

══════════════════════════════════════
ARCHON SYSTEMS CONTEXT
══════════════════════════════════════
You work across these active Archon projects — understand how they interrelate:

• Kairos          — crypto scalping signal web app (Next.js App Router, Supabase, Binance WebSocket, Resend email, Vercel)
• Chronos         — trading dashboard with advanced charting (formerly Kairon)
• Augur           — local ML trade predictor, scores Kairos signals (Level 1 advisory, Level 2 gating)
• PhantomTag      — VST plugin monitoring + Phantom Vault for music producers (Next.js, Supabase Storage)
• Argos           — SMB data platform and API builder (schema-per-tenant, law-enforcement-grade security)
• Primordial      — co-evolutionary neural network simulation (prey/predator agents)
• archon-base     — reusable full-stack monorepo template (static → AI → SaaS → enterprise tiers)
• Raziel          — this agent (you), the agentic coding employee

Common stack: Next.js 14/15 App Router · TypeScript · Tailwind CSS · Supabase (Postgres + Auth + Storage + Realtime) · Vercel · Resend · Stripe · better-sqlite3 · Anthropic SDK

══════════════════════════════════════
CURRENT WORKFLOW: ${workflow.toUpperCase()}
══════════════════════════════════════
${workflowGuide[workflow] ?? workflowGuide.feature}

══════════════════════════════════════
MANDATORY PHASE ORDER — DO NOT SKIP
══════════════════════════════════════
1. PLAN        → Call create_plan FIRST. No exceptions. Write what you will do, what files you will touch, and why.
2. EXPLORE     → Use list_directory, read_file, search_codebase to deeply understand the code before changing anything.
               → Fetch linked issue with fetch_issue if an issue number was provided.
               → Read CLAUDE.md / AGENTS.md to understand conventions.
               → Save useful findings with save_memory.
3. IMPLEMENT   → Make targeted, minimal changes. Edit existing files, don't create new ones unless required.
               → Follow TypeScript strictly: no "any", explicit return types on all exports.
               → No placeholder comments ("// TODO", "// implement this").
               → No dead code.
4. VERIFY      → Call run_build. Fix every TypeScript error and build failure before proceeding.
5. TEST        → Call run_tests if a test script exists. Fix failures. If no tests exist for a critical change, write one.
6. LINT        → Call run_lint and fix any errors.
7. SECURITY    → Call security_scan. If any findings, fix before proceeding. Never call task_complete with secrets detected.
8. COMPLETE    → Call task_complete with a clear summary and full list of files changed.

══════════════════════════════════════
AGENT COLLABORATION
══════════════════════════════════════
You can collaborate with other RAZ roles:

• delegate_to_role  — Run another role as a sub-agent RIGHT NOW. You wait for the result. Use when you need a specialist to review or extend your work before you complete (e.g. "have RAZ-Sec audit my auth changes", "have RAZ-QA write tests for this feature").
• handoff_to_role   — Queue a follow-up task for another role AFTER you complete. You don't wait. Use when your work is done and the next step belongs to a specialist (e.g. "hand off to RAZ-Sec for final audit", "hand off to RAZ-Ops to check deployment readiness").

When delegating, pass meaningful context so the sub-agent has what it needs.
When handing off, include a clear description of what was done so the next agent can orient quickly.

══════════════════════════════════════
SECURITY RULES — ABSOLUTE, NON-NEGOTIABLE
══════════════════════════════════════
• Never read, write, expose, log, or reference .env files or any secrets
• Never run destructive commands: rm -rf, git reset --hard, git push --force, DROP TABLE, DELETE without WHERE
• Never make outbound HTTP requests from tools
• Never leave hardcoded credentials, API keys, or tokens in code
• Always work within the worktree path — reject anything that escapes it
• Run security_scan before every task_complete call
• If you discover pre-existing secrets in the codebase, report them in task_complete notes but do not remove them without explicit instruction

══════════════════════════════════════
CODE QUALITY RULES
══════════════════════════════════════
• Read CLAUDE.md / AGENTS.md first — these define project-specific rules that override general guidance
• Prefer editing existing files over creating new ones
• Match the existing code style exactly (naming, spacing, import order, file structure)
• TypeScript: strict types, no "any", explicit return types on exported functions
• No console.log in production code
• No commented-out code
• Conventional commits: feat:, fix:, refactor:, chore:, test:, docs:

══════════════════════════════════════
WHEN STUCK OR UNCERTAIN
══════════════════════════════════════
• If a task is ambiguous, make the best reasonable interpretation — document it in your plan and proceed
• If you hit an error after 3 attempts to fix it, stop and call task_complete with a "blocked" explanation
• Never loop endlessly — if you are going in circles, explain why and stop

${context ? `══════════════════════════════════════\nPROJECT CONTEXT\n══════════════════════════════════════\n${context}` : ''}${memoryBlock}${historyBlock}${issueBlock}${resumeBlock}${delegationBlock}`
}

// ── Main agent loop ───────────────────────────────────────────────────────────
export async function runAgent(task: AgentTask, onEvent: EventCallback, signal?: AbortSignal): Promise<void> {
  const {
    taskId, repoPath, description, branch, workflow,
    role, repoId, issueNumber, github, checkpointMessages,
    parentTaskId, parentRole, maxIterations = 40, existingWorktree,
  } = task

  const roleDefinition = ROLES[role ?? DEFAULT_ROLE]
  const isResume       = !!(checkpointMessages?.length)
  const isSubAgent     = !!existingWorktree
  let worktreePath: string | null = existingWorktree ?? null

  try {
    if (existingWorktree) {
      onEvent({ type: 'thinking', message: `[sub-agent] Starting in parent worktree: ${path.basename(existingWorktree)}` })
    } else {
      onEvent({ type: 'thinking', message: isResume ? `Resuming from checkpoint (${checkpointMessages!.length} messages saved)…` : `Initializing worktree on branch: ${branch}` })
      worktreePath = setupWorktree(repoPath, branch)
    }

    const context    = readContextFiles(repoPath)
    const memory     = repoId ? getMemory(repoId) : {}
    const pastTasks  = repoId ? listTasks(repoId).slice(0, 10) : []

    let issueContent: string | undefined
    if (issueNumber && repoId) {
      const cached = getIssue(repoId, issueNumber)
      if (cached) issueContent = `#${cached.number}: ${cached.title}\n\n${cached.body ?? ''}`
    }

    const systemPrompt = buildSystemPrompt({
      context, memory, pastTasks, workflow, isResume, parentRole,
      roleContext: roleDefinition.systemContext,
      issueContent,
    })

    const roleTools = TOOLS.filter((t) => roleDefinition.allowedTools.includes(t.name))

    const messages: Anthropic.MessageParam[] = isResume
      ? (checkpointMessages as Anthropic.MessageParam[])
      : [{ role: 'user', content: `Task: ${description}${issueNumber ? `\n\nLinked issue: #${issueNumber}` : ''}` }]

    // ── Agent collaboration callbacks ─────────────────────────────────────────
    const runSubAgent: ToolContext['runSubAgent'] = async (params) => {
      const subRole    = params.role as RoleId
      const subTaskId  = randomUUID()
      const subWf      = params.workflow ?? (
        subRole === 'RAZ-Sec' ? 'audit' :
        subRole === 'RAZ-QA'  ? 'test'  :
        subRole === 'RAZ-Ops' ? 'strategy' : 'feature'
      )

      // Create DB record for the sub-task
      if (repoId) {
        const { createTask } = await import('./db')
        createTask(subTaskId, repoId, params.description, branch, subWf, undefined, subRole)
        if (taskId) setTaskParent(subTaskId, taskId)
      }

      // Log the delegation
      let msgId: number | undefined
      if (repoId) {
        msgId = createAgentMessage({
          repoId, fromRole: role ?? DEFAULT_ROLE, toRole: subRole,
          fromTaskId: taskId, toTaskId: subTaskId,
          messageType: 'delegation', message: params.description,
        })
      }

      onEvent({
        type: 'delegation',
        message: `→ ${subRole}: ${params.description.slice(0, 100)}`,
        data: { subRole, subTaskId, parentRole: role, isDelegation: true },
      })

      let subSummary = 'Sub-agent completed without summary.'
      let subFailed  = false

      await runAgent(
        {
          taskId:           subTaskId,
          repoPath,
          description:      params.description,
          branch,
          workflow:         subWf,
          role:             subRole,
          repoId,
          github,
          existingWorktree: worktreePath ?? undefined,
          parentTaskId:     taskId,
          parentRole:       role,
          maxIterations:    20,
        },
        (event) => {
          onEvent({
            ...event,
            message: `[${subRole}] ${event.message}`,
            data: { ...event.data, delegated: true, delegateRole: subRole },
          })
          if (event.type === 'complete') subSummary = event.message
          if (event.type === 'error')    { subFailed = true; subSummary = event.message }
        },
        signal,
      )

      if (repoId && msgId !== undefined) {
        updateAgentMessageResult(msgId, subFailed ? `FAILED: ${subSummary}` : subSummary)
      }

      onEvent({
        type: 'delegation',
        message: `← ${subRole} ${subFailed ? 'failed' : 'complete'}: ${subSummary.slice(0, 100)}`,
        data: { subRole, subTaskId, complete: true, failed: subFailed, delegated: false },
      })

      return subFailed ? `FAILED: ${subSummary}` : subSummary
    }

    const queueHandoff: ToolContext['queueHandoff'] = async (params) => {
      const toRole   = params.role as RoleId
      const newId    = randomUUID()
      const toWf     = params.workflow ?? (
        toRole === 'RAZ-Sec' ? 'audit' :
        toRole === 'RAZ-QA'  ? 'test'  :
        toRole === 'RAZ-Ops' ? 'strategy' : 'feature'
      )
      const branchSlug = params.description.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 25).replace(/-$/, '')
      const newBranch  = `${toRole.toLowerCase().replace('-', '')}/handoff-${branchSlug}-${newId.slice(0, 6)}`
      const fullDesc   = params.context
        ? `${params.description}\n\nContext from ${role ?? 'parent agent'}:\n${params.context}`
        : params.description

      if (repoId) {
        createQueuedTask(newId, repoId, fullDesc, newBranch, toWf, toRole, taskId)
        createAgentMessage({
          repoId, fromRole: role ?? DEFAULT_ROLE, toRole,
          fromTaskId: taskId, toTaskId: newId,
          messageType: 'handoff', message: params.description,
          context: params.context,
        })
      }

      onEvent({
        type: 'handoff',
        message: `⟶ ${toRole}: ${params.description.slice(0, 80)}`,
        data: { taskId: newId, role: toRole, description: fullDesc, workflow: toWf, branch: newBranch },
      })

      return newId
    }

    const toolCtx: ToolContext = {
      worktreePath: worktreePath!,
      repoId,
      taskId,
      parentRole: role,
      github,
      runSubAgent,
      queueHandoff,
    }

    let iterations      = 0
    let planCreated     = false
    let buildVerified   = false
    let securityClean   = false
    const extraGatesMet = new Map<string, boolean>(roleDefinition.extraGates.map((g) => [g, false]))
    let totalInputTokens  = 0
    let totalOutputTokens = 0
    const recentCalls: string[] = []

    const INPUT_COST_PER_M  = 3.00
    const OUTPUT_COST_PER_M = 15.00

    while (iterations < maxIterations) {
      iterations++

      if (signal?.aborted) { onEvent({ type: 'error', message: 'Task cancelled.' }); return }

      const response = await callWithBackoff(
        () => anthropic.messages.create({
          model:      'claude-sonnet-4-6',
          max_tokens: 8096,
          system:     systemPrompt,
          tools:      roleTools as unknown as Anthropic.Tool[],
          messages,
        }),
        (attempt, delayMs) => onEvent({
          type:    'thinking',
          message: `Rate limited — waiting ${delayMs / 1000}s then retrying (attempt ${attempt}/5)…`,
        }),
        signal,
      )

      const toolUses   = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text')

      totalInputTokens  += response.usage.input_tokens
      totalOutputTokens += response.usage.output_tokens
      const costUsd = (totalInputTokens / 1_000_000) * INPUT_COST_PER_M + (totalOutputTokens / 1_000_000) * OUTPUT_COST_PER_M

      onEvent({ type: 'usage', message: `~$${costUsd.toFixed(4)}`, data: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, costUsd } })

      if (textBlocks.length > 0) {
        onEvent({ type: 'thinking', message: textBlocks.map((b) => b.text).join('\n') })
      }

      // Stuck-loop detection
      for (const t of toolUses) {
        const sig = `${t.name}:${JSON.stringify(t.input).slice(0, 150)}`
        recentCalls.push(sig)
      }
      if (recentCalls.length > 12) recentCalls.splice(0, recentCalls.length - 12)
      if (recentCalls.length >= 6) {
        const counts = new Map<string, number>()
        for (const s of recentCalls) counts.set(s, (counts.get(s) ?? 0) + 1)
        const stuck = [...counts.entries()].find(([, n]) => n >= 3)
        if (stuck) {
          onEvent({ type: 'error', message: `Stuck loop detected — "${stuck[0].split(':')[0]}" called 3× with identical input. Stopping to protect API spend. Retry to resume from checkpoint.` })
          return
        }
      }

      // Gate: plan before writes
      const writingWithoutPlan = !planCreated && toolUses.some((t) =>
        ['write_file', 'execute_bash', 'run_build', 'run_tests', 'run_lint'].includes(t.name)
      )
      if (writingWithoutPlan) {
        messages.push({ role: 'assistant', content: response.content })
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUses[0].id, content: 'ERROR: You must call create_plan before making any changes.' }] })
        saveTaskMessages(taskId, messages)
        continue
      }

      // Completion check
      const completeCall = toolUses.find((t) => t.name === 'task_complete')
      if (completeCall) {
        const inp = completeCall.input as { summary: string; files_changed: string[]; notes?: string }

        if (roleDefinition.buildRequired && !buildVerified && workflow !== 'strategy' && workflow !== 'audit') {
          messages.push({ role: 'assistant', content: response.content })
          messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: completeCall.id, content: 'ERROR: You must call run_build before task_complete.' }] })
          saveTaskMessages(taskId, messages)
          continue
        }
        if (roleDefinition.securityRequired && !securityClean) {
          messages.push({ role: 'assistant', content: response.content })
          messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: completeCall.id, content: 'ERROR: You must call security_scan before task_complete.' }] })
          saveTaskMessages(taskId, messages)
          continue
        }
        const unmetGates = roleDefinition.extraGates.filter((g) => !extraGatesMet.get(g))
        if (unmetGates.length > 0) {
          messages.push({ role: 'assistant', content: response.content })
          messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: completeCall.id, content: `ERROR: You must call the following tools before task_complete: ${unmetGates.join(', ')}` }] })
          saveTaskMessages(taskId, messages)
          continue
        }

        const costUsdFinal = (totalInputTokens / 1_000_000) * INPUT_COST_PER_M + (totalOutputTokens / 1_000_000) * OUTPUT_COST_PER_M

        // Sub-agents don't commit — parent owns the commit
        if (!isSubAgent) {
          try {
            commitChanges(worktreePath!, inp.summary, workflow, roleDefinition.commitPrefix)
          } catch {}
        }

        onEvent({ type: 'complete', message: inp.summary, data: { files_changed: inp.files_changed, notes: inp.notes, branch, costUsd: costUsdFinal, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, isSubAgent } })
        return
      }

      if (response.stop_reason === 'end_turn' && toolUses.length === 0) {
        onEvent({ type: 'complete', message: 'Agent finished without explicit completion.', data: { branch, isSubAgent } })
        return
      }

      // Execute tools
      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const toolUse of toolUses) {
        onEvent({ type: 'tool_call', message: toolUse.name, data: { input: toolUse.input } })

        const result = await executeTool(toolUse.name as ToolName, toolUse.input as Record<string, unknown>, toolCtx)

        if (toolUse.name === 'create_plan')  { planCreated  = true; onEvent({ type: 'plan', message: (toolUse.input as Record<string, unknown>).plan as string }) }
        if (toolUse.name === 'run_build')      buildVerified = true
        if (toolUse.name === 'security_scan')  securityClean = !result.startsWith('SECURITY ALERT')
        if (extraGatesMet.has(toolUse.name))   extraGatesMet.set(toolUse.name, true)

        onEvent({ type: 'tool_result', message: result.slice(0, 300) })
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result })
      }

      messages.push({ role: 'assistant', content: response.content })
      messages.push({ role: 'user', content: toolResults })

      // Checkpoint after every iteration
      saveTaskMessages(taskId, messages)
    }

    onEvent({ type: 'error', message: `Agent hit max iterations (${maxIterations}). Task incomplete. Retry to resume from the last checkpoint.` })
  } catch (err) {
    onEvent({ type: 'error', message: `Agent error: ${err}` })
  } finally {
    // Only clean up worktrees we created — not borrowed parent worktrees
    if (worktreePath && !isSubAgent) cleanupWorktree(repoPath, worktreePath)
  }
}
