import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import path from 'path'
import fs from 'fs'

// Context injected via env vars by agent-cc.ts when spawning Claude Code
const TASK_ID      = process.env.RAZ_TASK_ID!
const REPO_ID      = process.env.RAZ_REPO_ID ? Number(process.env.RAZ_REPO_ID) : undefined
const WORKTREE     = process.env.RAZ_WORKTREE!
const GITHUB_OWNER = process.env.RAZ_GITHUB_OWNER ?? ''
const GITHUB_REPO  = process.env.RAZ_GITHUB_REPO  ?? ''

// Derive project-level dirs from the DB path passed by agent-cc.ts
const DB_DIR      = path.dirname(process.env.RAZ_DB_PATH ?? path.join(process.cwd(), '.raziel', 'raziel.db'))
const REPORTS_DIR = path.join(DB_DIR, 'reports')

import { randomUUID } from 'crypto'
import { setMemory, getMemory, listTasks, savePlan, createQuestion, getQuestionAnswer, getConfig } from './db'

async function checkPauseOrAbort() {
  while (true) {
    const paused = getConfig('task_paused')
    if (paused !== '1') break
    await new Promise((r) => setTimeout(r, 1_000))
  }
}

const server = new McpServer({ name: 'raz', version: '1.0.0' })

// ── create_plan ───────────────────────────────────────────────────────────────
server.tool(
  'create_plan',
  'Save your implementation plan before making any changes. Required before Write, Edit, or Bash.',
  { plan: z.string().describe('Full implementation plan') },
  async ({ plan }) => {
    await checkPauseOrAbort()
    savePlan(TASK_ID, plan)
    return { content: [{ type: 'text' as const, text: 'Plan saved. Proceed with exploration and implementation.' }] }
  },
)

// ── save_memory ───────────────────────────────────────────────────────────────
server.tool(
  'save_memory',
  'Persist a finding about this codebase for future agents. Call after every significant read or discovery.',
  {
    key:   z.string().describe('Memory key: file:<path>, finding:<slug>, pattern:<name>, fix:<slug>'),
    value: z.string().describe('Concise summary — what it does, key exports, gotchas'),
  },
  async ({ key, value }) => {
    await checkPauseOrAbort()
    if (REPO_ID) setMemory(REPO_ID, key, value)
    return { content: [{ type: 'text' as const, text: `Memory saved: ${key}` }] }
  },
)

// ── ask_user ──────────────────────────────────────────────────────────────────
server.tool(
  'ask_user',
  'Ask the user a question and wait for their response before continuing. Use when you need a decision, confirmation, or information only the user can provide. The UI will show a prompt and block until they answer.',
  {
    question:   z.string().describe('The question to ask the user'),
    options:    z.array(z.object({ label: z.string(), description: z.string().optional() })).optional().describe('Multiple choice options. Omit for free-text input.'),
    input_type: z.enum(['choice', 'text']).optional().describe('"choice" (buttons) or "text" (input box). Inferred from options if omitted.'),
  },
  async ({ question, options, input_type }) => {
    await checkPauseOrAbort()
    const mode = getConfig('raz_mode') ?? 'standard'
    if (mode === 'autonomous') {
      return { content: [{ type: 'text' as const, text: `Autonomous mode — no user input required. Use your best judgment to proceed.` }] }
    }

    const qId = randomUUID()
    createQuestion(qId, TASK_ID, question, options, input_type ?? (options?.length ? 'choice' : 'text'))

    let waited = 0
    while (waited < 900_000) {
      await checkPauseOrAbort()
      await new Promise((r) => setTimeout(r, 1_000))
      waited += 1_000
      const answer = getQuestionAnswer(qId)
      if (answer !== null) {
        return { content: [{ type: 'text' as const, text: `User answered: "${answer}"` }] }
      }
    }
    return { content: [{ type: 'text' as const, text: 'No response received within 15 minutes. Use your best judgment to proceed, or call task_complete explaining the blocker.' }] }
  },
)

// ── get_memory ────────────────────────────────────────────────────────────────
server.tool(
  'get_memory',
  'Load everything this agent system knows about the current repo — findings, patterns, file roles, past decisions. Call this first at the start of every task.',
  {},
  async () => {
    await checkPauseOrAbort()
    if (!REPO_ID) return { content: [{ type: 'text' as const, text: 'No repo context available.' }] }
    const memory   = getMemory(REPO_ID)
    const tasks    = listTasks(REPO_ID).slice(0, 10)
    const entries  = Object.entries(memory)

    const memBlock  = entries.length > 0
      ? `REPO MEMORY (${entries.length} entries):\n${entries.map(([k, v]) => `- ${k}: ${v}`).join('\n')}`
      : 'No memory entries yet.'

    const histBlock = tasks.length > 0
      ? `\nRECENT TASK HISTORY:\n${tasks.map((t) => `- [${t.status}] [${t.workflow ?? 'feature'}] ${t.description}${t.summary ? ` → ${t.summary}` : ''}`).join('\n')}`
      : ''

    return { content: [{ type: 'text' as const, text: `${memBlock}${histBlock}` }] }
  },
)

// ── get_role_context ──────────────────────────────────────────────────────────
server.tool(
  'get_role_context',
  'Returns your own role definition: what tools you can use, which workflows you can run, your handoff rules, and your commit prefix. Call this if you are unsure about your own capabilities or constraints.',
  {},
  async () => {
    await checkPauseOrAbort()
    const roleId = process.env.RAZ_ROLE ?? 'RAZ-Dev'
    const { ROLES } = await import('./roles')
    const role = ROLES[roleId as keyof typeof ROLES]
    if (!role) return { content: [{ type: 'text' as const, text: `Unknown role: ${roleId}` }] }

    const text = [
      `ROLE: ${role.id}`,
      `DESCRIPTION: ${role.description}`,
      `COMMIT PREFIX: ${role.commitPrefix}`,
      `ALLOWED TOOLS: ${role.allowedTools.join(', ')}`,
      `REQUIRED GATES (must call before task_complete): ${role.extraGates.length > 0 ? role.extraGates.join(', ') : 'none'}`,
      `BUILD REQUIRED: ${role.buildRequired}`,
      `SECURITY SCAN REQUIRED: ${role.securityRequired}`,
      ``,
      `SYSTEM INSTRUCTIONS:`,
      role.systemContext,
    ].join('\n')

    return { content: [{ type: 'text' as const, text }] }
  },
)

// ── task_complete ─────────────────────────────────────────────────────────────
server.tool(
  'task_complete',
  'Signal that the task is done. Call security_scan first. Provide a summary and list of changed files.',
  {
    summary:       z.string().describe('One-paragraph summary of what was done'),
    files_changed: z.array(z.string()).describe('Relative paths of every file you created or modified'),
    notes:         z.string().optional().describe('Notes for the human reviewer (pre-existing issues, caveats)'),
  },
  async ({ summary, files_changed, notes }) => {
    await checkPauseOrAbort()
    const marker     = JSON.stringify({ summary, files_changed, notes: notes ?? null })
    const markerPath = path.join(WORKTREE, '.raziel-completion.json')
    fs.writeFileSync(markerPath, marker, 'utf-8')
    return { content: [{ type: 'text' as const, text: `TASK_COMPLETE: ${summary}` }] }
  },
)

// ── security_scan ─────────────────────────────────────────────────────────────
server.tool(
  'security_scan',
  'Scan changed files for secrets, hardcoded credentials, and dangerous patterns. Required before task_complete.',
  { paths: z.array(z.string()).describe('File paths relative to the worktree root to scan') },
  async ({ paths }) => {
    const findings: string[] = []
    const secretPatterns = [
      { name: 'Anthropic API Key',    regex: /sk-ant-api[0-9a-z-]{20,}/i },
      { name: 'GitHub PAT',           regex: /ghp_[a-zA-Z0-9]{36}/ },
      { name: 'AWS Access Key',       regex: /AKIA[0-9A-Z]{16}/ },
      { name: 'Private Key',          regex: /-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY/ },
      { name: 'Hardcoded Password',   regex: /password\s*[:=]\s*['"][^'"]{6,}['"]/i },
      { name: 'Hardcoded Secret',     regex: /secret\s*[:=]\s*['"][^'"]{8,}['"]/i },
      { name: 'Stripe Key',           regex: /sk_live_[a-zA-Z0-9]{24,}/ },
      { name: 'Supabase Service Key', regex: /eyJhbGciOiJIUzI1NiJ9\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/ },
    ]

    for (const rel of paths) {
      const abs = path.resolve(WORKTREE, rel)
      if (!abs.startsWith(WORKTREE)) continue
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue
      const content = fs.readFileSync(abs, 'utf-8')
      for (const { name, regex } of secretPatterns) {
        if (regex.test(content)) findings.push(`${rel}: ${name}`)
      }
    }

    if (findings.length > 0) {
      return { content: [{ type: 'text' as const, text: `SECURITY ALERT — findings:\n${findings.join('\n')}\n\nFix these before calling task_complete.` }] }
    }
    return { content: [{ type: 'text' as const, text: 'Security scan passed. No secrets or dangerous patterns detected.' }] }
  },
)

// ── generate_report ───────────────────────────────────────────────────────────
server.tool(
  'generate_report',
  'Save a structured markdown report to .raziel/reports/. Use for audit findings, ops assessments, coverage summaries.',
  {
    title:    z.string().describe('Report title'),
    summary:  z.string().describe('Executive summary (2-5 sentences)'),
    findings: z.string().describe('Full findings in markdown — headings, bullet points, severity labels, remediation steps.'),
  },
  async ({ title, summary, findings }) => {
    fs.mkdirSync(REPORTS_DIR, { recursive: true })
    const slug     = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/-$/, '')
    const date     = new Date().toISOString().split('T')[0]
    const filename = `${date}-${slug}.md`
    const content  = `# ${title}\n\n**Generated:** ${new Date().toISOString()}\n\n## Summary\n\n${summary}\n\n## Findings\n\n${findings}`
    fs.writeFileSync(path.join(REPORTS_DIR, filename), content, 'utf-8')
    if (REPO_ID) setMemory(REPO_ID, `report:${slug}`, `${summary}\n\nFull report: .raziel/reports/${filename}`)
    return { content: [{ type: 'text' as const, text: `OK: Report saved to .raziel/reports/${filename}\n\nPreview:\n${content.slice(0, 400)}${content.length > 400 ? '\n...[truncated]' : ''}` }] }
  },
)

// ── delegate_to_role ──────────────────────────────────────────────────────────
server.tool(
  'delegate_to_role',
  'Run another RAZ role as a sub-agent right now. You wait for the result before continuing.',
  {
    role:        z.enum(['RAZ-Dev', 'RAZ-Sec', 'RAZ-QA', 'RAZ-Ops', 'RAZ-Data']),
    description: z.string().describe('What the sub-agent should do'),
    workflow:    z.string().optional().describe('Workflow type: feature, fix, audit, test, strategy'),
  },
  async ({ role, description, workflow }) => {
    await checkPauseOrAbort()
    const delegationPath = path.join(WORKTREE, '.raziel-delegate.json')
    fs.writeFileSync(delegationPath, JSON.stringify({ role, description, workflow }), 'utf-8')

    const resultPath = path.join(WORKTREE, '.raziel-delegate-result.json')
    let waited = 0
    while (!fs.existsSync(resultPath) && waited < 1_800_000) {
      await new Promise((r) => setTimeout(r, 500))
      waited += 500
    }

    if (!fs.existsSync(resultPath)) {
      return { content: [{ type: 'text' as const, text: `DELEGATION TIMEOUT: ${role} did not respond within 30 minutes.` }] }
    }

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as { summary: string; failed: boolean }
    fs.unlinkSync(resultPath)
    return { content: [{ type: 'text' as const, text: result.failed ? `FAILED: ${result.summary}` : result.summary }] }
  },
)

// ── handoff_to_role ───────────────────────────────────────────────────────────
server.tool(
  'handoff_to_role',
  'Queue a follow-up task for another RAZ role after you complete. You do not wait for it.',
  {
    role:        z.enum(['RAZ-Dev', 'RAZ-Sec', 'RAZ-QA', 'RAZ-Ops', 'RAZ-Data']),
    description: z.string().describe('What the next agent should do'),
    context:     z.string().optional().describe('Summary of your work to orient the next agent'),
    workflow:    z.string().optional(),
  },
  async ({ role, description, context, workflow }) => {
    await checkPauseOrAbort()
    const handoffPath = path.join(WORKTREE, '.raziel-handoff.json')
    const existing = fs.existsSync(handoffPath)
      ? JSON.parse(fs.readFileSync(handoffPath, 'utf-8')) as unknown[]
      : []
    ;(existing as unknown[]).push({ role, description, context, workflow })
    fs.writeFileSync(handoffPath, JSON.stringify(existing), 'utf-8')
    return { content: [{ type: 'text' as const, text: `Handoff queued → ${role}: ${description.slice(0, 80)}` }] }
  },
)

// ── fetch_issue ───────────────────────────────────────────────────────────────
server.tool(
  'fetch_issue',
  'Fetch a single GitHub issue by number.',
  { number: z.number().describe('Issue number') },
  async ({ number }) => {
    const { fetchIssue } = await import('./github')
    const text = await fetchIssue(GITHUB_OWNER, GITHUB_REPO, number)
    return { content: [{ type: 'text' as const, text }] }
  },
)

// ── list_open_issues ──────────────────────────────────────────────────────────
server.tool(
  'list_open_issues',
  'List open GitHub issues for the current repo.',
  { limit: z.number().optional().describe('Max issues to return (default 20)') },
  async ({ limit }) => {
    const { listOpenIssues } = await import('./github')
    const text = await listOpenIssues(GITHUB_OWNER, GITHUB_REPO, limit ?? 20)
    return { content: [{ type: 'text' as const, text }] }
  },
)

// ── list_open_prs ─────────────────────────────────────────────────────────────
server.tool(
  'list_open_prs',
  'List open pull requests for the current repo.',
  {},
  async () => {
    const { listOpenPRs } = await import('./github')
    const text = await listOpenPRs(GITHUB_OWNER, GITHUB_REPO)
    return { content: [{ type: 'text' as const, text }] }
  },
)

// ── review_pr ─────────────────────────────────────────────────────────────────
server.tool(
  'review_pr',
  'Fetch full context for a GitHub PR: metadata, file list, CI status, existing reviews, and the complete diff. Call this at the start of any code review task.',
  { pr_number: z.number().describe('Pull request number to review') },
  async ({ pr_number }) => {
    await checkPauseOrAbort()
    const { getPRDetails, getPRDiff } = await import('./github')
    const [details, diff] = await Promise.all([
      getPRDetails(GITHUB_OWNER, GITHUB_REPO, pr_number),
      getPRDiff(GITHUB_OWNER, GITHUB_REPO, pr_number),
    ])

    const fileList = details.files
      .map((f) => `  ${f.status.padEnd(8)} +${f.additions}/-${f.deletions}  ${f.filename}`)
      .join('\n')

    const comments = details.comments.length > 0
      ? details.comments.map((c) => `  [${c.author}] ${c.body.slice(0, 200)}`).join('\n')
      : '  (none)'

    const text = [
      `PR #${details.number}: ${details.title}`,
      `State: ${details.state}${details.merged ? ' (merged)' : ''}  |  CI: ${details.ciStatus}  |  Approvals: ${details.approvals}`,
      `Author: ${details.author}  |  Created: ${details.createdAt.slice(0, 10)}`,
      ``,
      `DESCRIPTION:`,
      details.body?.slice(0, 800) ?? '(no description)',
      ``,
      `FILES CHANGED (${details.files.length}):`,
      fileList,
      ``,
      `EXISTING COMMENTS:`,
      comments,
      ``,
      `DIFF (capped at 40KB):`,
      diff || '(diff not available — PR may already be merged)',
    ].join('\n')

    return { content: [{ type: 'text' as const, text }] }
  },
)

// ── post_pr_review ────────────────────────────────────────────────────────────
server.tool(
  'post_pr_review',
  'Post a code review to a GitHub PR. Use after reviewing with review_pr. Verdict: "approve", "comment", or "request_changes".',
  {
    pr_number: z.number().describe('Pull request number'),
    body:      z.string().describe('Full review body in markdown — summarize findings, list issues with severity, note what is good'),
    verdict:   z.enum(['approve', 'comment', 'request_changes']).describe('"approve" if code is clean, "request_changes" if issues must be fixed, "comment" for informational only'),
  },
  async ({ pr_number, body, verdict }) => {
    await checkPauseOrAbort()
    const eventMap = { approve: 'APPROVE', comment: 'COMMENT', request_changes: 'REQUEST_CHANGES' } as const
    const { createPRReview } = await import('./github')
    const url = await createPRReview(GITHUB_OWNER, GITHUB_REPO, pr_number, body, eventMap[verdict])
    return { content: [{ type: 'text' as const, text: `Review posted (${verdict}): ${url}` }] }
  },
)

// ── Start server ──────────────────────────────────────────────────────────────
;(async () => {
  const transport = new StdioServerTransport()
  await server.connect(transport)
})()
