import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { TOOLS, executeTool, ToolName, ToolContext } from './tools'
import { getMemory, setMemory, listTasks, getIssue } from './db'
import { ROLES, DEFAULT_ROLE, type RoleId } from './roles'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface AgentTask {
  taskId:      string
  repoPath:    string
  description: string
  branch:      string
  workflow:    string
  role?:       RoleId
  repoId?:     number
  issueNumber?: number
  github?:     { owner: string; repo: string }
}

export interface AgentEvent {
  type:    'thinking' | 'tool_call' | 'tool_result' | 'plan' | 'usage' | 'complete' | 'error'
  message: string
  data?:   Record<string, unknown>
}

export type EventCallback = (event: AgentEvent) => void

function readContextFiles(repoPath: string): string {
  const files = ['CLAUDE.md', 'AGENTS.md', 'README.md', '.raziel/context.md']
  const parts: string[] = []
  for (const file of files) {
    const p = path.join(repoPath, file)
    if (fs.existsSync(p)) parts.push(`=== ${file} ===\n${fs.readFileSync(p, 'utf-8')}`)
  }
  return parts.join('\n\n')
}

function setupWorktree(repoPath: string, branch: string): string {
  const worktreePath = path.join(repoPath, '..', `.raziel-worktree-${branch.replace(/\//g, '-')}`)
  try {
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
  try { execSync(`git worktree remove --force "${worktreePath}"`, { cwd: repoPath }) } catch {}
}

function commitChanges(worktreePath: string, summary: string, workflow: string, commitPrefix: string) {
  execSync('git add -A', { cwd: worktreePath })
  const type    = workflow === 'fix' ? 'fix' : workflow === 'refactor' ? 'refactor' : workflow === 'audit' ? 'chore' : 'feat'
  const message = `${type}(${commitPrefix}): ${summary.slice(0, 72)}\n\nAutomated by RAZ — Archon Systems`
  execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: worktreePath })
}

function buildSystemPrompt(params: {
  context:       string
  memory:        Record<string, string>
  pastTasks:     ReturnType<typeof listTasks>
  workflow:      string
  roleContext:   string
  issueContent?: string
}): string {
  const { context, memory, pastTasks, workflow, roleContext, issueContent } = params

  const memoryBlock = Object.keys(memory).length > 0
    ? `\n\nREPO MEMORY (what you know about this codebase):\n${Object.entries(memory).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`
    : ''

  const historyBlock = pastTasks.length > 0
    ? `\n\nRECENT TASK HISTORY (last ${pastTasks.length} tasks on this repo):\n${pastTasks.map((t) => `- [${t.status}] [${t.workflow ?? 'feature'}] ${t.description}${t.summary ? ` → ${t.summary}` : ''}`).join('\n')}`
    : ''

  const issueBlock = issueContent
    ? `\n\nLINKED GITHUB ISSUE:\n${issueContent}`
    : ''

  const workflowGuide: Record<string, string> = {
    feature:   'You are implementing a new feature. Plan it thoroughly. Write clean, typed code. No placeholders.',
    fix:       'You are fixing a bug. Diagnose root cause first. Write minimal, targeted changes. Add a test if a test suite exists.',
    refactor:  'You are improving existing code. Do not change behavior. Clean up, extract, rename, simplify. Run tests after to confirm nothing broke.',
    audit:     'You are performing a security and code quality audit. Read widely, identify issues, write a detailed report, and fix what you can safely fix.',
    strategy:  'You are researching and strategizing. Read the codebase, understand the problem space, and produce a detailed written plan. You may create or update docs but should not make code changes.',
    test:      'You are writing or improving tests. Understand what exists, identify gaps, write comprehensive test cases, run them to confirm they pass.',
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
               → Follow Tailwind and component conventions found in the codebase.
               → No placeholder comments ("// TODO", "// implement this").
               → No dead code.
4. VERIFY      → Call run_build. Fix every TypeScript error and build failure before proceeding.
5. TEST        → Call run_tests if a test script exists. Fix failures. If no tests exist for a critical change, write one.
6. LINT        → Call run_lint and fix any errors.
7. SECURITY    → Call security_scan. If any findings, fix before proceeding. Never call task_complete with secrets detected.
8. COMPLETE    → Call task_complete with a clear summary and full list of files changed.

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
• No console.log in production code (use the project's logger if one exists)
• No commented-out code
• No multi-line docstrings or obvious comments — code should be self-documenting
• Conventional commits: feat:, fix:, refactor:, chore:, test:, docs:

══════════════════════════════════════
WHEN STUCK OR UNCERTAIN
══════════════════════════════════════
• If a task is ambiguous, make the best reasonable interpretation — document it in your plan and proceed
• If you hit an error after 3 attempts to fix it, stop and call task_complete with a "blocked" explanation
• Never loop endlessly — if you are going in circles, explain why and stop
• If implementing the task would require breaking security rules, stop and explain in task_complete

${context ? `══════════════════════════════════════\nPROJECT CONTEXT\n══════════════════════════════════════\n${context}` : ''}${memoryBlock}${historyBlock}${issueBlock}`
}

export async function runAgent(task: AgentTask, onEvent: EventCallback, signal?: AbortSignal): Promise<void> {
  const { taskId, repoPath, description, branch, workflow, role, repoId, issueNumber, github } = task
  const roleDefinition = ROLES[role ?? DEFAULT_ROLE]
  let worktreePath: string | null = null

  try {
    onEvent({ type: 'thinking', message: `Initializing worktree on branch: ${branch}` })
    worktreePath = setupWorktree(repoPath, branch)

    const context    = readContextFiles(repoPath)
    const memory     = repoId ? getMemory(repoId) : {}
    const pastTasks  = repoId ? listTasks(repoId).slice(0, 10) : []

    let issueContent: string | undefined
    if (issueNumber && repoId) {
      const cached = getIssue(repoId, issueNumber)
      if (cached) {
        issueContent = `#${cached.number}: ${cached.title}\n\n${cached.body ?? ''}`
      }
    }

    const systemPrompt = buildSystemPrompt({
      context, memory, pastTasks, workflow,
      roleContext: roleDefinition.systemContext,
      issueContent,
    })

    const roleTools = TOOLS.filter((t) => roleDefinition.allowedTools.includes(t.name))

    const messages: Anthropic.MessageParam[] = [
      {
        role:    'user',
        content: `Task: ${description}${issueNumber ? `\n\nLinked issue: #${issueNumber}` : ''}`,
      },
    ]

    const toolCtx: ToolContext = { worktreePath, repoId, taskId, github }

    let iterations     = 0
    const MAX          = 40
    let planCreated    = false
    let buildVerified  = false
    let securityClean  = false
    const extraGatesMet = new Map<string, boolean>(
      roleDefinition.extraGates.map((g) => [g, false])
    )
    let totalInputTokens  = 0
    let totalOutputTokens = 0

    // Sonnet 4.6 pricing per million tokens
    const INPUT_COST_PER_M  = 3.00
    const OUTPUT_COST_PER_M = 15.00

    while (iterations < MAX) {
      iterations++

      if (signal?.aborted) {
        onEvent({ type: 'error', message: 'Task cancelled.' })
        return
      }

      const response = await anthropic.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 8096,
        system:     systemPrompt,
        tools:      roleTools as unknown as Anthropic.Tool[],
        messages,
      })

      const toolUses   = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text')

      totalInputTokens  += response.usage.input_tokens
      totalOutputTokens += response.usage.output_tokens
      const costUsd = (totalInputTokens / 1_000_000) * INPUT_COST_PER_M + (totalOutputTokens / 1_000_000) * OUTPUT_COST_PER_M

      onEvent({ type: 'usage', message: `~$${costUsd.toFixed(4)}`, data: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, costUsd } })

      if (textBlocks.length > 0) {
        onEvent({ type: 'thinking', message: textBlocks.map((b) => b.text).join('\n') })
      }

      // Gate: enforce plan before any write/execute
      const writingWithoutPlan = !planCreated && toolUses.some((t) =>
        ['write_file', 'execute_bash', 'run_build', 'run_tests', 'run_lint'].includes(t.name)
      )
      if (writingWithoutPlan) {
        messages.push({ role: 'assistant', content: response.content })
        messages.push({
          role: 'user', content: [{
            type: 'tool_result',
            tool_use_id: toolUses[0].id,
            content: 'ERROR: You must call create_plan before making any changes. Create your plan first.',
          }],
        })
        continue
      }

      // Check for completion
      const completeCall = toolUses.find((t) => t.name === 'task_complete')
      if (completeCall) {
        const inp = completeCall.input as { summary: string; files_changed: string[]; notes?: string }

        if (roleDefinition.buildRequired && !buildVerified && workflow !== 'strategy' && workflow !== 'audit') {
          messages.push({ role: 'assistant', content: response.content })
          messages.push({
            role: 'user', content: [{
              type: 'tool_result',
              tool_use_id: completeCall.id,
              content: 'ERROR: You must call run_build before task_complete to verify there are no TypeScript or build errors.',
            }],
          })
          continue
        }

        if (roleDefinition.securityRequired && !securityClean) {
          messages.push({ role: 'assistant', content: response.content })
          messages.push({
            role: 'user', content: [{
              type: 'tool_result',
              tool_use_id: completeCall.id,
              content: 'ERROR: You must call security_scan before task_complete.',
            }],
          })
          continue
        }

        const unmetGates = roleDefinition.extraGates.filter((g) => !extraGatesMet.get(g))
        if (unmetGates.length > 0) {
          messages.push({ role: 'assistant', content: response.content })
          messages.push({
            role: 'user', content: [{
              type: 'tool_result',
              tool_use_id: completeCall.id,
              content: `ERROR: You must call the following tools before task_complete: ${unmetGates.join(', ')}`,
            }],
          })
          continue
        }

        try {
          const costUsdFinal = (totalInputTokens / 1_000_000) * INPUT_COST_PER_M + (totalOutputTokens / 1_000_000) * OUTPUT_COST_PER_M
          commitChanges(worktreePath, inp.summary, workflow, roleDefinition.commitPrefix)
          onEvent({
            type:    'complete',
            message: inp.summary,
            data:    { files_changed: inp.files_changed, notes: inp.notes, branch, costUsd: costUsdFinal, inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
          })
        } catch {
          const costUsdFinal = (totalInputTokens / 1_000_000) * INPUT_COST_PER_M + (totalOutputTokens / 1_000_000) * OUTPUT_COST_PER_M
          onEvent({
            type:    'complete',
            message: inp.summary,
            data:    { files_changed: inp.files_changed, notes: inp.notes, branch, commit_skipped: true, costUsd: costUsdFinal, inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
          })
        }
        return
      }

      if (response.stop_reason === 'end_turn' && toolUses.length === 0) {
        onEvent({ type: 'complete', message: 'Agent finished without explicit completion.', data: { branch } })
        return
      }

      // Execute tools
      const toolResults: Anthropic.ToolResultBlockParam[] = []

      for (const toolUse of toolUses) {
        onEvent({ type: 'tool_call', message: toolUse.name, data: { input: toolUse.input } })

        const result = await executeTool(toolUse.name as ToolName, toolUse.input as Record<string, unknown>, toolCtx)

        if (toolUse.name === 'create_plan')   planCreated   = true
        if (toolUse.name === 'run_build')      buildVerified = true
        if (toolUse.name === 'security_scan')  securityClean = !result.startsWith('SECURITY ALERT')
        if (extraGatesMet.has(toolUse.name))   extraGatesMet.set(toolUse.name, true)

        // Surface plan to UI
        if (toolUse.name === 'create_plan') {
          onEvent({ type: 'plan', message: (toolUse.input as Record<string, unknown>).plan as string })
        }

        onEvent({ type: 'tool_result', message: result.slice(0, 300) })

        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result })
      }

      messages.push({ role: 'assistant', content: response.content })
      messages.push({ role: 'user', content: toolResults })
    }

    onEvent({ type: 'error', message: 'Agent hit max iterations (40). Task incomplete.' })
  } catch (err) {
    onEvent({ type: 'error', message: `Agent error: ${err}` })
  } finally {
    if (worktreePath) cleanupWorktree(repoPath, worktreePath)
  }
}
