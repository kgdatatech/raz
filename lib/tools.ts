import fs from 'fs'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { getConfig, setMemory, savePlan } from './db'
import {
  fetchIssue, listOpenIssues, listOpenPRs,
  getPRDetails, getPRFileDiff, createPRReview,
} from './github'

const execAsync = promisify(exec)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitWhilePaused(): Promise<void> {
  while (getConfig('task_paused') === '1') {
    await sleep(1_000)
  }
}

// Env passed to all child processes — strips RAZ's own secrets so agents can't echo them
function safeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const { ANTHROPIC_API_KEY, GITHUB_TOKEN, GITHUB_PAT, RESEND_API_KEY, ...rest } = process.env
  void ANTHROPIC_API_KEY; void GITHUB_TOKEN; void GITHUB_PAT; void RESEND_API_KEY
  return { ...rest, ...extra }
}

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

// All shell commands in the worktree go through this — routes via WSL for WSL paths
async function execInPath(
  cmd: string,
  cwd: string,
  opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  if (isWslPath(cwd)) {
    const distro   = wslDistro(cwd)
    const linuxCwd = toLinuxPath(cwd)
    // Prepend simple env vars (CI, NODE_ENV) that tools need inside WSL
    const envPrefix = [
      opts.env?.CI       ? `CI=${opts.env.CI}`             : '',
      opts.env?.NODE_ENV ? `NODE_ENV=${opts.env.NODE_ENV}` : '',
    ].filter(Boolean).join(' ')
    const inner = `cd ${JSON.stringify(linuxCwd)} && ${envPrefix ? envPrefix + ' ' : ''}${cmd}`
    return execAsync(`wsl -d ${distro} -- bash -c ${JSON.stringify(inner)}`, { timeout: opts.timeout })
  }
  return execAsync(cmd, { cwd, ...opts })
}

export interface ToolContext {
  worktreePath:  string
  repoId?:       number
  taskId?:       string
  parentRole?:   string
  github?:       { owner: string; repo: string }
  runSubAgent?:  (params: { role: string; description: string; workflow?: string }) => Promise<string>
  queueHandoff?: (params: { role: string; description: string; workflow?: string; context?: string }) => Promise<string>
}

// Raw bash allowlist — these are the only commands the agent can run via execute_bash
const ALLOWED_COMMANDS = [
  /^git\s/,
  /^npm\s/,
  /^npx\s/,
  /^pnpm\s/,
  /^yarn\s/,
  /^ls(\s|$)/,
  /^cat\s/,
  /^find\s/,
  /^grep\s/,
  /^echo\s/,
  /^mkdir\s/,
  /^cp\s/,
  /^mv\s/,
  /^touch\s/,
  /^node\s/,
  /^tsc(\s|$)/,
  /^tsx(\s|$)/,
  /^prettier\s/,
  /^eslint\s/,
  /^vitest(\s|$)/,
  /^jest(\s|$)/,
  /^mocha(\s|$)/,
  /^python3?\s/,
  /^which\s/,
  /^pwd$/,
  /^wc\s/,
  /^head\s/,
  /^tail\s/,
  /^diff\s/,
  /^sort(\s|$)/,
  /^uniq(\s|$)/,
]

// Paths the agent can never access
const BLOCKED_PATHS = [
  '.env', '.env.local', '.env.production', '.env.development',
  '.env.staging', '.env.test', 'secrets', '.secret', '.secrets',
  'id_rsa', 'id_ed25519', '*.pem', '*.key',
]

// Secret patterns for security scanning
const SECRET_PATTERNS = [
  { name: 'Anthropic API Key',    regex: /sk-ant-api[0-9a-z-]{20,}/i },
  { name: 'GitHub PAT',           regex: /ghp_[a-zA-Z0-9]{36}/ },
  { name: 'GitHub App Token',     regex: /ghs_[a-zA-Z0-9]{36}/ },
  { name: 'AWS Access Key',       regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'Google API Key',       regex: /AIza[0-9a-zA-Z\-_]{35}/ },
  { name: 'Slack Token',          regex: /xox[baprs]-[0-9a-zA-Z-]+/ },
  { name: 'Private Key',          regex: /-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY/ },
  { name: 'Hardcoded Password',   regex: /password\s*[:=]\s*['"][^'"]{6,}['"]/i },
  { name: 'Hardcoded Secret',     regex: /secret\s*[:=]\s*['"][^'"]{8,}['"]/i },
  { name: 'Hardcoded API Key',    regex: /api[_-]?key\s*[:=]\s*['"][^'"]{8,}['"]/i },
  { name: 'DB Connection String', regex: /(postgres|mysql|mongodb)\+?:\/\/[^@:\s]+:[^@\s]+@/i },
  { name: 'Stripe Key',           regex: /sk_live_[a-zA-Z0-9]{24,}/ },
  { name: 'Supabase Service Key', regex: /eyJhbGciOiJIUzI1NiJ9\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/ },
  { name: 'OpenAI API Key',       regex: /sk-proj-[a-zA-Z0-9_-]{50,}|sk-[a-zA-Z0-9]{48}/ },
  { name: 'DATABASE_URL',         regex: /DATABASE_URL\s*[:=]\s*['"]?[a-zA-Z]+:\/\/[^'";\s\n]{10,}/ },
]

function isBlockedPath(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase()
  return BLOCKED_PATHS.some((b) => {
    if (b.startsWith('*')) return base.endsWith(b.slice(1))
    return base === b || base.startsWith(b + '.')
  })
}

function isAllowedCommand(cmd: string): boolean {
  return ALLOWED_COMMANDS.some((p) => p.test(cmd.trim()))
}

async function detectPackageManager(cwd: string): Promise<string> {
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (fs.existsSync(path.join(cwd, 'yarn.lock')))      return 'yarn'
  return 'npm'
}

async function readPackageScripts(cwd: string): Promise<Record<string, string>> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'))
    return pkg.scripts ?? {}
  } catch {
    return {}
  }
}

export const TOOLS = [
  // ── Filesystem ──────────────────────────────────────────────────────────────
  {
    name: 'read_file',
    description: 'Read a file in the repo. Blocked on .env and secret files.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to repo root' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write or overwrite a file. Creates directories if needed.',
    input_schema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'File path relative to repo root' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories at a path.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to repo root. Use "." for root.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_codebase',
    description: 'Search for a pattern across all files in the repo. Returns matching lines with context.',
    input_schema: {
      type: 'object',
      properties: {
        pattern:     { type: 'string', description: 'Regex or literal search pattern' },
        file_glob:   { type: 'string', description: 'File glob to filter (e.g. "*.ts", "*.tsx"). Omit to search all.' },
        context_lines: { type: 'number', description: 'Lines of context around each match (0-5, default 2)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'get_diff',
    description: 'Show git diff of all changes made so far in the worktree.',
    input_schema: {
      type: 'object',
      properties: {
        stat_only: { type: 'boolean', description: 'If true, return only the --stat summary. Default false.' },
      },
      required: [],
    },
  },

  // ── Execution ────────────────────────────────────────────────────────────────
  {
    name: 'execute_bash',
    description: 'Run an allowlisted shell command in the worktree. Use for git status, file ops, and diagnostics.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
      },
      required: ['command'],
    },
  },
  {
    name: 'run_build',
    description: 'Run TypeScript type-check (tsc --noEmit) and the build script. Reports errors. Always run before task_complete.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'run_tests',
    description: 'Run the project test suite (jest/vitest/mocha). Reports pass/fail. Run after implementing changes.',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Optional test name filter pattern' },
      },
      required: [],
    },
  },
  {
    name: 'run_lint',
    description: 'Run ESLint on the codebase or specific files. Fix any errors it reports.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to lint (relative to repo root). Omit to lint entire project.' },
      },
      required: [],
    },
  },

  // ── Planning & Memory ────────────────────────────────────────────────────────
  {
    name: 'create_plan',
    description: 'Write your implementation plan BEFORE making any code changes. Required first step for every task.',
    input_schema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'Your structured plan: what you will do, what files you will touch, and why.' },
      },
      required: ['plan'],
    },
  },
  {
    name: 'save_memory',
    description: 'Persist a key insight about this codebase for future tasks (conventions, gotchas, architecture).',
    input_schema: {
      type: 'object',
      properties: {
        key:   { type: 'string', description: 'Short label (e.g. "auth_pattern", "db_migrations")' },
        value: { type: 'string', description: 'What you learned' },
      },
      required: ['key', 'value'],
    },
  },

  // ── Security ─────────────────────────────────────────────────────────────────
  {
    name: 'security_scan',
    description: 'Scan all changed files for secrets, API keys, and vulnerabilities. Must call before task_complete.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // ── GitHub ───────────────────────────────────────────────────────────────────
  {
    name: 'fetch_issue',
    description: 'Fetch a GitHub issue by number. Use when the task references an issue.',
    input_schema: {
      type: 'object',
      properties: {
        number: { type: 'number', description: 'GitHub issue number' },
      },
      required: ['number'],
    },
  },
  {
    name: 'list_issues',
    description: 'List open GitHub issues for this repo. Use to find related issues or understand what needs doing.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max issues to return (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'list_open_prs',
    description: 'List open pull requests for the current repo.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_pr_summary',
    description: 'Fetch PR metadata, file list, CI status, and existing comments — no diff. Always call this first in a code review. Then call get_pr_file_diff for specific files.',
    input_schema: {
      type: 'object',
      properties: {
        pr_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['pr_number'],
    },
  },
  {
    name: 'get_pr_file_diff',
    description: 'Fetch the diff for a single file in a PR (capped at 8KB). Call get_pr_summary first to see the file list.',
    input_schema: {
      type: 'object',
      properties: {
        pr_number: { type: 'number', description: 'Pull request number' },
        filename:  { type: 'string', description: 'Exact filename from the get_pr_summary file list (e.g. "lib/agent-sdk.ts")' },
      },
      required: ['pr_number', 'filename'],
    },
  },
  {
    name: 'post_pr_review',
    description: 'Post a code review to a GitHub PR. Verdict: "approve", "comment", or "request_changes". For pre-merge reviews (workflow=review) only use approve or request_changes — never comment.',
    input_schema: {
      type: 'object',
      properties: {
        pr_number: { type: 'number', description: 'Pull request number' },
        body:      { type: 'string', description: 'Review body — summarize findings, list issues with file/line/severity if requesting changes' },
        verdict:   { type: 'string', enum: ['approve', 'comment', 'request_changes'], description: 'Review verdict' },
      },
      required: ['pr_number', 'body', 'verdict'],
    },
  },

  // ── Specialized ──────────────────────────────────────────────────────────────
  {
    name: 'dependency_audit',
    description: 'Run a dependency vulnerability audit (npm/pnpm/yarn audit). Returns severity summary.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'generate_report',
    description: 'Save a structured markdown report to .raziel/reports/. Use for audit findings, ops assessments, coverage summaries.',
    input_schema: {
      type: 'object',
      properties: {
        title:    { type: 'string', description: 'Report title' },
        summary:  { type: 'string', description: 'Executive summary (2-5 sentences)' },
        findings: { type: 'string', description: 'Full findings in markdown — headings, bullet points, severity labels, remediation steps.' },
      },
      required: ['title', 'summary', 'findings'],
    },
  },
  {
    name: 'check_coverage',
    description: 'Run the test suite with coverage reporting and return the coverage summary.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'validate_migration',
    description: 'Validate a SQL migration file for dangerous patterns (DROP without IF EXISTS, DELETE without WHERE, TRUNCATE, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to SQL migration file relative to repo root' },
      },
      required: ['path'],
    },
  },

  // ── Agent Communication ──────────────────────────────────────────────────────
  {
    name: 'delegate_to_role',
    description: 'Run another RAZ role as a sub-agent inline. The sub-agent works in the same codebase, completes its task, and returns a summary. Use to get a specialist review (e.g. delegate to RAZ-Sec to audit your changes, or RAZ-QA to write tests).',
    input_schema: {
      type: 'object',
      properties: {
        role:     { type: 'string', enum: ['RAZ-Dev', 'RAZ-Sec', 'RAZ-QA', 'RAZ-Ops', 'RAZ-Data'], description: 'Which agent role to run' },
        task:     { type: 'string', description: 'What you need this role to do — be specific' },
        workflow: { type: 'string', enum: ['feature', 'fix', 'refactor', 'audit', 'test', 'strategy'], description: 'Workflow type for the sub-agent' },
        context:  { type: 'string', description: 'Relevant context to pass — files changed, specific concerns, what you already tried' },
      },
      required: ['role', 'task'],
    },
  },
  {
    name: 'handoff_to_role',
    description: 'Queue a follow-up task for another RAZ role to run after you complete. Unlike delegate_to_role, you do NOT wait for the result — it queues immediately and the user sees it in the UI. Use when your task is done and the next step belongs to a different specialist.',
    input_schema: {
      type: 'object',
      properties: {
        role:     { type: 'string', enum: ['RAZ-Dev', 'RAZ-Sec', 'RAZ-QA', 'RAZ-Ops', 'RAZ-Data'], description: 'Which agent role should handle the follow-up' },
        task:     { type: 'string', description: 'What the next role should do' },
        workflow: { type: 'string', enum: ['feature', 'fix', 'refactor', 'audit', 'test', 'strategy'], description: 'Workflow type' },
        context:  { type: 'string', description: 'Context to pass to the next agent' },
      },
      required: ['role', 'task'],
    },
  },

  // ── Completion ───────────────────────────────────────────────────────────────
  {
    name: 'task_complete',
    description: 'Signal task completion. Only call after required gates are met (check role instructions).',
    input_schema: {
      type: 'object',
      properties: {
        summary:       { type: 'string', description: 'What was done and why' },
        files_changed: { type: 'array', items: { type: 'string' }, description: 'Files created or modified' },
        notes:         { type: 'string', description: 'Optional notes for the reviewer (edge cases, known limitations, follow-up needed)' },
      },
      required: ['summary', 'files_changed'],
    },
  },
] as const

export type ToolName =
  | 'read_file' | 'write_file' | 'list_directory' | 'search_codebase' | 'get_diff'
  | 'execute_bash' | 'run_build' | 'run_tests' | 'run_lint'
  | 'create_plan' | 'save_memory' | 'security_scan'
  | 'fetch_issue' | 'list_issues'
  | 'list_open_prs' | 'get_pr_summary' | 'get_pr_file_diff' | 'post_pr_review'
  | 'dependency_audit' | 'generate_report' | 'check_coverage' | 'validate_migration'
  | 'delegate_to_role' | 'handoff_to_role'
  | 'task_complete'

export async function executeTool(
  name: ToolName,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  await waitWhilePaused()
  const { worktreePath, repoId, taskId, github } = ctx

  switch (name) {

    // ── read_file ─────────────────────────────────────────────────────────────
    case 'read_file': {
      const rel      = input.path as string
      const filePath = path.resolve(worktreePath, rel)
      if (isBlockedPath(rel)) return 'ERROR: Access to this file is blocked for security.'
      if (!filePath.startsWith(path.resolve(worktreePath))) return 'ERROR: Path traversal not allowed.'
      try {
        const content = fs.readFileSync(filePath, 'utf-8')
        const CAP = 6_000
        if (content.length <= CAP) return content
        const lineCount = content.split('\n').length
        return `${content.slice(0, CAP)}\n\n[FILE TRUNCATED — ${content.length} chars / ${lineCount} lines shown as ${CAP} chars]\nUse search_codebase to locate specific sections, or read_file with a narrower path if this is a directory index.`
      } catch {
        return `ERROR: Could not read file: ${rel}`
      }
    }

    // ── write_file ────────────────────────────────────────────────────────────
    case 'write_file': {
      const rel      = input.path as string
      const filePath = path.resolve(worktreePath, rel)
      if (isBlockedPath(rel)) return 'ERROR: Cannot write to this file.'
      if (!filePath.startsWith(path.resolve(worktreePath))) return 'ERROR: Path traversal not allowed.'
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, input.content as string, 'utf-8')
        return `OK: Written ${rel}`
      } catch (e) {
        return `ERROR: Could not write file: ${e}`
      }
    }

    // ── list_directory ────────────────────────────────────────────────────────
    case 'list_directory': {
      const rel     = input.path as string
      const dirPath = path.resolve(worktreePath, rel)
      if (!dirPath.startsWith(path.resolve(worktreePath))) return 'ERROR: Path traversal not allowed.'
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })
        return entries
          .filter((e) => !BLOCKED_PATHS.includes(e.name))
          .map((e) => `${e.isDirectory() ? '[dir] ' : '[file]'} ${e.name}`)
          .join('\n')
      } catch {
        return `ERROR: Could not list directory: ${rel}`
      }
    }

    // ── search_codebase ───────────────────────────────────────────────────────
    case 'search_codebase': {
      const pattern  = input.pattern as string
      const glob     = (input.file_glob as string | undefined) ?? ''
      const ctx_lines = Math.min(Number(input.context_lines ?? 2), 5)
      const includeFlag = glob ? `--include="${glob}"` : '--include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.json" --include="*.md" --include="*.css"'
      const cmd = `grep -rn ${includeFlag} -C ${ctx_lines} ${JSON.stringify(pattern)} . 2>/dev/null | head -200`
      try {
        const { stdout } = await execInPath(cmd, worktreePath, { timeout: 15_000 })
        return stdout.trim() || `No matches found for: ${pattern}`
      } catch (e: unknown) {
        const err = e as { stdout?: string }
        return err.stdout?.trim() || `No matches found for: ${pattern}`
      }
    }

    // ── get_diff ──────────────────────────────────────────────────────────────
    case 'get_diff': {
      const statOnly = input.stat_only as boolean | undefined
      try {
        const { stdout: stat } = await execInPath('git diff --stat HEAD', worktreePath)
        if (statOnly) return stat.trim() || 'No changes yet.'
        const { stdout: diff } = await execInPath('git diff HEAD', worktreePath)
        const trimmed = diff.slice(0, 4000)
        return `${stat.trim()}\n\n${trimmed}${diff.length > 4000 ? '\n...[truncated]' : ''}`
      } catch {
        return 'No changes detected yet.'
      }
    }

    // ── execute_bash ──────────────────────────────────────────────────────────
    case 'execute_bash': {
      const command = input.command as string
      if (!isAllowedCommand(command)) {
        return `ERROR: Command not allowed: "${command}"\nAllowed: git, npm, npx, pnpm, yarn, ls, cat, find, grep, echo, mkdir, cp, mv, touch, node, tsc, tsx, prettier, eslint, vitest, jest, mocha, python, which, pwd, wc, head, tail, diff`
      }
      try {
        const { stdout, stderr } = await execInPath(command, worktreePath, {
          timeout: 60_000,
          env: safeEnv({ NODE_ENV: process.env.NODE_ENV ?? 'development' }),
        })
        return (stdout + stderr).trim() || 'OK: Command completed with no output.'
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string; message?: string }
        return `ERROR: ${err.stderr || err.stdout || err.message}`
      }
    }

    // ── run_build ─────────────────────────────────────────────────────────────
    case 'run_build': {
      const results: string[] = []
      const pm = await detectPackageManager(worktreePath)

      // TypeScript check
      const hasTsConfig = fs.existsSync(path.join(worktreePath, 'tsconfig.json'))
      if (hasTsConfig) {
        try {
          const { stdout, stderr } = await execInPath('npx tsc --noEmit 2>&1', worktreePath, { timeout: 120_000 })
          const out = (stdout + stderr).trim()
          results.push(`[tsc] ${out || 'PASS — no type errors'}`)
        } catch (e: unknown) {
          const err = e as { stdout?: string; stderr?: string }
          results.push(`[tsc] ERRORS:\n${(err.stdout || err.stderr || '').trim()}`)
        }
      }

      // Build script
      const scripts = await readPackageScripts(worktreePath)
      if (scripts.build) {
        try {
          const { stdout, stderr } = await execInPath(`${pm} run build 2>&1`, worktreePath, { timeout: 180_000 })
          const out = (stdout + stderr).trim()
          results.push(`[build] ${out.slice(0, 2000)}${out.length > 2000 ? '\n...[truncated]' : ''}`)
        } catch (e: unknown) {
          const err = e as { stdout?: string; stderr?: string }
          results.push(`[build] FAILED:\n${((err.stdout || err.stderr || '')).slice(0, 2000)}`)
        }
      }

      return results.length > 0 ? results.join('\n\n') : 'No build configuration found (no tsconfig.json or build script).'
    }

    // ── run_tests ─────────────────────────────────────────────────────────────
    case 'run_tests': {
      const scripts = await readPackageScripts(worktreePath)
      const pm = await detectPackageManager(worktreePath)
      const filter = input.filter as string | undefined

      if (!scripts.test || scripts.test === 'echo "Error: no test specified" && exit 1') {
        return 'No test suite configured in package.json.'
      }

      const cmd = filter
        ? `${pm} test -- ${filter} 2>&1`
        : `${pm} test 2>&1`

      try {
        const { stdout, stderr } = await execInPath(cmd, worktreePath, { timeout: 90_000, env: safeEnv({ CI: 'true' }) })
        const out = (stdout + stderr).trim()
        return out.slice(0, 3000) + (out.length > 3000 ? '\n...[truncated]' : '')
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string }
        const out = ((err.stdout || '') + (err.stderr || '')).trim()
        return `TESTS FAILED:\n${out.slice(0, 3000)}`
      }
    }

    // ── run_lint ──────────────────────────────────────────────────────────────
    case 'run_lint': {
      const target  = (input.path as string | undefined) ?? '.'
      const scripts = await readPackageScripts(worktreePath)
      const pm      = await detectPackageManager(worktreePath)

      if (scripts.lint) {
        try {
          const { stdout, stderr } = await execInPath(`${pm} run lint 2>&1`, worktreePath, { timeout: 60_000 })
          return ((stdout + stderr).trim() || 'PASS — no lint errors').slice(0, 3000)
        } catch (e: unknown) {
          const err = e as { stdout?: string; stderr?: string }
          return `LINT ERRORS:\n${((err.stdout || err.stderr || '')).slice(0, 3000)}`
        }
      }

      // Fallback: direct eslint
      try {
        const { stdout, stderr } = await execInPath(`npx eslint ${target} 2>&1`, worktreePath, { timeout: 60_000 })
        return ((stdout + stderr).trim() || 'PASS — no lint errors').slice(0, 3000)
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string }
        return `LINT ERRORS:\n${((err.stdout || err.stderr || '')).slice(0, 3000)}`
      }
    }

    // ── create_plan ───────────────────────────────────────────────────────────
    case 'create_plan': {
      const plan = input.plan as string
      if (taskId) savePlan(taskId, plan)
      return `OK: Plan recorded.\n\n${plan}`
    }

    // ── save_memory ───────────────────────────────────────────────────────────
    case 'save_memory': {
      if (repoId !== undefined) {
        setMemory(repoId, input.key as string, input.value as string)
        return `OK: Memory saved — "${input.key}"`
      }
      return 'OK: Memory skipped (no repoId in context)'
    }

    // ── security_scan ─────────────────────────────────────────────────────────
    case 'security_scan': {
      let changedFiles: string[] = []
      try {
        const { stdout } = await execInPath('git diff --name-only HEAD', worktreePath)
        changedFiles = stdout.trim().split('\n').filter(Boolean)
      } catch {
        // No commits yet — scan all tracked files
        try {
          const { stdout } = await execInPath('git ls-files', worktreePath)
          changedFiles = stdout.trim().split('\n').filter(Boolean).slice(0, 50)
        } catch {}
      }

      if (changedFiles.length === 0) return 'CLEAN: No changed files to scan.'

      const findings: string[] = []

      for (const file of changedFiles) {
        const filePath = path.join(worktreePath, file)
        if (!fs.existsSync(filePath) || isBlockedPath(file)) continue
        let content: string
        try { content = fs.readFileSync(filePath, 'utf-8') } catch { continue }

        for (const { name, regex } of SECRET_PATTERNS) {
          if (regex.test(content)) findings.push(`  [${name}] in ${file}`)
        }
      }

      if (findings.length === 0) {
        return `CLEAN: Scanned ${changedFiles.length} file(s) — no secrets or sensitive patterns detected.`
      }

      return `SECURITY ALERT — ${findings.length} finding(s) in ${changedFiles.length} file(s):\n${findings.join('\n')}\n\nDo NOT call task_complete. Remove these before proceeding.`
    }

    // ── fetch_issue ───────────────────────────────────────────────────────────
    case 'fetch_issue': {
      if (!github) return 'ERROR: No GitHub context available.'
      try {
        return await fetchIssue(github.owner, github.repo, input.number as number)
      } catch (e) {
        return `ERROR: Could not fetch issue: ${e}`
      }
    }

    // ── list_issues ───────────────────────────────────────────────────────────
    case 'list_issues': {
      if (!github) return 'ERROR: No GitHub context available.'
      try {
        return await listOpenIssues(github.owner, github.repo, (input.limit as number | undefined) ?? 20)
      } catch (e) {
        return `ERROR: Could not list issues: ${e}`
      }
    }

    // ── list_open_prs ─────────────────────────────────────────────────────────
    case 'list_open_prs': {
      if (!github) return 'ERROR: No GitHub context available.'
      try {
        return await listOpenPRs(github.owner, github.repo)
      } catch (e) {
        return `ERROR: Could not list PRs: ${e}`
      }
    }

    // ── get_pr_summary ────────────────────────────────────────────────────────
    case 'get_pr_summary': {
      if (!github) return 'ERROR: No GitHub context available.'
      try {
        const prNumber = input.pr_number as number
        const details  = await getPRDetails(github.owner, github.repo, prNumber)
        const fileList = details.files
          .map((f) => `  ${f.status.padEnd(8)} +${f.additions}/-${f.deletions}  ${f.filename}`)
          .join('\n')
        const comments = details.comments.length > 0
          ? details.comments.map((c) => `  [${c.author}] ${c.body.slice(0, 200)}`).join('\n')
          : '  (none)'
        return [
          `PR #${details.number}: ${details.title}`,
          `State: ${details.state}${details.merged ? ' (merged)' : ''}  |  CI: ${details.ciStatus}  |  Approvals: ${details.approvals}`,
          `Author: ${details.author}  |  Created: ${details.createdAt.slice(0, 10)}`,
          ``,
          `DESCRIPTION:`,
          details.body?.slice(0, 600) ?? '(no description)',
          ``,
          `FILES CHANGED (${details.files.length}) — use get_pr_file_diff to inspect specific files:`,
          fileList,
          ``,
          `EXISTING COMMENTS:`,
          comments,
        ].join('\n')
      } catch (e) {
        return `ERROR: Could not fetch PR summary: ${e}`
      }
    }

    // ── get_pr_file_diff ──────────────────────────────────────────────────────
    case 'get_pr_file_diff': {
      if (!github) return 'ERROR: No GitHub context available.'
      try {
        return await getPRFileDiff(github.owner, github.repo, input.pr_number as number, input.filename as string)
      } catch (e) {
        return `ERROR: Could not fetch file diff: ${e}`
      }
    }

    // ── post_pr_review ────────────────────────────────────────────────────────
    case 'post_pr_review': {
      if (!github) return 'ERROR: No GitHub context available.'
      try {
        const verdictMap: Record<string, 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'> = {
          approve:          'APPROVE',
          request_changes:  'REQUEST_CHANGES',
          comment:          'COMMENT',
        }
        const event = verdictMap[input.verdict as string] ?? 'COMMENT'
        return await createPRReview(github.owner, github.repo, input.pr_number as number, input.body as string, event)
      } catch (e) {
        return `ERROR: Could not post review: ${e}`
      }
    }

    // ── dependency_audit ─────────────────────────────────────────────────────
    case 'dependency_audit': {
      const pm = await detectPackageManager(worktreePath)
      const auditCmd = pm === 'pnpm' ? 'pnpm audit' : pm === 'yarn' ? 'yarn audit' : 'npm audit'
      try {
        const { stdout, stderr } = await execInPath(`${auditCmd} 2>&1`, worktreePath, { timeout: 60_000 })
        const out = (stdout + stderr).trim()
        return `DEPENDENCY AUDIT:\n${out.slice(0, 3000)}${out.length > 3000 ? '\n...[truncated]' : ''}`
      } catch (e: unknown) {
        // npm audit exits non-zero when vulnerabilities exist — output is still valid
        const err = e as { stdout?: string; stderr?: string }
        const out = ((err.stdout || '') + (err.stderr || '')).trim()
        return `DEPENDENCY AUDIT (vulnerabilities found):\n${out.slice(0, 3000)}${out.length > 3000 ? '\n...[truncated]' : ''}`
      }
    }

    // ── generate_report ───────────────────────────────────────────────────────
    case 'generate_report': {
      const title    = input.title as string
      const summary  = input.summary as string
      const findings = input.findings as string
      const dir      = path.join(process.cwd(), '.raziel', 'reports')
      fs.mkdirSync(dir, { recursive: true })
      const slug     = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/-$/, '')
      const date     = new Date().toISOString().split('T')[0]
      const filename = `${date}-${slug}.md`
      const content  = `# ${title}\n\n**Generated:** ${new Date().toISOString()}\n\n## Summary\n\n${summary}\n\n## Findings\n\n${findings}`
      fs.writeFileSync(path.join(dir, filename), content, 'utf-8')
      // Also persist to repo memory so it appears in the Memory tab
      if (ctx.repoId) {
        setMemory(ctx.repoId, `report:${slug}`, `${summary}\n\nFull report: .raziel/reports/${filename}`)
      }
      return `OK: Report saved to .raziel/reports/${filename}\n\nPreview:\n${content.slice(0, 400)}${content.length > 400 ? '\n...[truncated]' : ''}`
    }

    // ── check_coverage ────────────────────────────────────────────────────────
    case 'check_coverage': {
      const scripts = await readPackageScripts(worktreePath)
      const pm = await detectPackageManager(worktreePath)
      if (!scripts.test || scripts.test === 'echo "Error: no test specified" && exit 1') {
        return 'No test suite configured in package.json.'
      }
      const cmd = `${pm} test -- --coverage --coverageReporters=text 2>&1`
      try {
        const { stdout, stderr } = await execInPath(cmd, worktreePath, { timeout: 120_000, env: safeEnv({ CI: 'true' }) })
        const out   = (stdout + stderr).trim()
        const lines = out.split('\n')
        const start = lines.findIndex((l) => l.includes('% Stmts') || l.includes('Coverage summary') || l.includes('Stmts'))
        const block = start >= 0 ? lines.slice(Math.max(0, start - 1)).join('\n') : out.slice(-2000)
        return `COVERAGE:\n${block.slice(0, 2000)}`
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string }
        return `COVERAGE FAILED:\n${((err.stdout || '') + (err.stderr || '')).slice(0, 2000)}`
      }
    }

    // ── validate_migration ────────────────────────────────────────────────────
    case 'validate_migration': {
      const rel      = input.path as string
      const filePath = path.resolve(worktreePath, rel)
      if (!filePath.startsWith(path.resolve(worktreePath))) return 'ERROR: Path traversal not allowed.'
      let sql: string
      try { sql = fs.readFileSync(filePath, 'utf-8') } catch { return `ERROR: Could not read migration file: ${rel}` }

      const DANGEROUS: { pattern: RegExp; name: string }[] = [
        { pattern: /DROP\s+TABLE\b(?!\s+IF\s+EXISTS)/i,  name: 'DROP TABLE without IF EXISTS' },
        { pattern: /DROP\s+COLUMN\b/i,                   name: 'DROP COLUMN (irreversible — ensure data is backed up)' },
        { pattern: /DELETE\s+FROM\b(?![^;]*\bWHERE\b)/im, name: 'DELETE without WHERE clause' },
        { pattern: /TRUNCATE\b/i,                        name: 'TRUNCATE (irreversible)' },
        { pattern: /DROP\s+DATABASE\b/i,                 name: 'DROP DATABASE' },
        { pattern: /DROP\s+SCHEMA\b/i,                   name: 'DROP SCHEMA' },
        { pattern: /ALTER\s+TABLE\b.*\bDROP\b/i,         name: 'ALTER TABLE ... DROP (column removal)' },
      ]

      const warnings = DANGEROUS.filter(({ pattern }) => pattern.test(sql)).map(({ name }) => `  ⚠ ${name}`)

      if (warnings.length === 0) {
        return `MIGRATION VALID: ${rel}\n\nNo dangerous patterns detected. Safe to proceed.`
      }

      return `MIGRATION WARNINGS — ${warnings.length} issue(s) in ${rel}:\n${warnings.join('\n')}\n\nReview carefully. If intentional, document the reason in your plan.`
    }

    // ── delegate_to_role ──────────────────────────────────────────────────────
    case 'delegate_to_role': {
      if (!ctx.runSubAgent) return 'ERROR: Delegation not available in this context.'
      const subRole = input.role as string
      const subTask = input.task as string
      const subWf   = input.workflow as string | undefined
      const subCtx  = input.context as string | undefined
      const fullDesc = subCtx
        ? `${subTask}\n\nContext from ${ctx.parentRole ?? 'parent agent'}:\n${subCtx}`
        : subTask
      try {
        const result = await ctx.runSubAgent({ role: subRole, description: fullDesc, workflow: subWf })
        return `[${subRole}] DELEGATION COMPLETE:\n${result}`
      } catch (e) {
        return `[${subRole}] DELEGATION FAILED: ${e}`
      }
    }

    // ── handoff_to_role ───────────────────────────────────────────────────────
    case 'handoff_to_role': {
      if (!ctx.queueHandoff) return 'ERROR: Handoff not available in this context.'
      const toRole  = input.role as string
      const toTask  = input.task as string
      const toWf    = input.workflow as string | undefined
      const toCtx   = input.context as string | undefined
      try {
        const newTaskId = await ctx.queueHandoff({ role: toRole, description: toTask, workflow: toWf, context: toCtx })
        return `HANDOFF QUEUED: ${toRole} will handle "${toTask.slice(0, 60)}${toTask.length > 60 ? '...' : ''}" (Task ID: ${newTaskId})`
      } catch (e) {
        return `HANDOFF FAILED: ${e}`
      }
    }

    // ── task_complete ─────────────────────────────────────────────────────────
    case 'task_complete': {
      return `COMPLETE: ${input.summary}`
    }

    default:
      return 'ERROR: Unknown tool.'
  }
}
