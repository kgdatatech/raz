import fs from 'fs'
import path from 'path'
import { spawn, execSync } from 'child_process'
import { ROLES, DEFAULT_ROLE } from './roles'
import { clearWorktreePath, getIssue, getRecentChatContext, saveWorktreePath } from './db'
import type { AgentTask, EventCallback } from './agent-sdk'

export type { AgentTask, AgentEvent, EventCallback } from './agent-sdk'

interface CompletionMarker {
  summary:       string
  files_changed: string[]
  notes?:        string | null
}

function codexCommand(): string {
  if (process.env.RAZ_CODEX_COMMAND) return process.env.RAZ_CODEX_COMMAND
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? '', 'npm', 'codex.cmd')
  return 'codex'
}

function setupWorktree(repoPath: string, branch: string, baseBranch: string): string {
  const slug = `.raziel-worktree-${branch.replace(/\//g, '-')}`
  const worktreePath = path.join(repoPath, '..', slug)
  try {
    if (fs.existsSync(worktreePath)) {
      execSync(`git worktree remove --force ${JSON.stringify(worktreePath)}`, { cwd: repoPath, stdio: 'pipe' })
    }
    try {
      execSync(`git worktree add -b ${JSON.stringify(branch)} ${JSON.stringify(worktreePath)} ${JSON.stringify(`origin/${baseBranch}`)}`, { cwd: repoPath, stdio: 'pipe' })
    } catch {
      execSync(`git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`, { cwd: repoPath, stdio: 'pipe' })
    }
    const mainModules = path.join(repoPath, 'node_modules')
    const worktreeModules = path.join(worktreePath, 'node_modules')
    if (fs.existsSync(mainModules) && !fs.existsSync(worktreeModules)) {
      try { fs.symlinkSync(mainModules, worktreeModules, 'junction') } catch {}
    }
    return worktreePath
  } catch (err) {
    throw new Error(`Failed to create Codex worktree: ${err}`)
  }
}

function cleanupWorktree(repoPath: string, worktreePath: string): void {
  try { execSync(`git worktree remove --force ${JSON.stringify(worktreePath)}`, { cwd: repoPath, stdio: 'pipe' }) } catch {}
}

function commitChanges(worktreePath: string, summary: string, workflow: string, commitPrefix: string): boolean {
  execSync('git add -A', { cwd: worktreePath, stdio: 'pipe' })
  try {
    execSync('git diff --cached --quiet', { cwd: worktreePath, stdio: 'pipe' })
    return false
  } catch {}

  const type = workflow === 'fix' ? 'fix' : workflow === 'refactor' ? 'refactor' : workflow === 'audit' ? 'chore' : 'feat'
  const message = `${type}(${commitPrefix}): ${summary.slice(0, 72)}\n\nAutomated by RAZ — Archon Systems (Codex)`
  execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: worktreePath, stdio: 'pipe' })
  return true
}

function readContextFiles(repoPath: string): string {
  const parts: string[] = []
  for (const file of ['AGENTS.md', 'CLAUDE.md', '.raziel/context.md']) {
    const fullPath = path.join(repoPath, file)
    if (!fs.existsSync(fullPath)) continue
    const raw = fs.readFileSync(fullPath, 'utf-8')
    parts.push(`=== ${file} ===\n${raw.slice(0, 6_000)}`)
  }
  return parts.join('\n\n')
}

function buildPrompt(task: AgentTask, worktreePath: string): string {
  const role = ROLES[task.role ?? DEFAULT_ROLE]
  const markerPath = path.join(worktreePath, '.raziel-completion.json')
  const issue = task.issueNumber && task.repoId ? getIssue(task.repoId, task.issueNumber) : null
  const chat = task.repoId ? getRecentChatContext(task.repoId) : ''

  return [
    `You are running inside RAZ as the ${role.id} agent using the Codex runner.`,
    role.systemContext,
    `Repository worktree: ${worktreePath}`,
    `Workflow: ${task.workflow}`,
    `Task: ${task.description}`,
    task.github ? `GitHub: ${task.github.owner}/${task.github.repo}` : '',
    issue ? `Linked issue #${issue.number}: ${issue.title}\n${issue.body ?? ''}` : '',
    chat ? `Recent RAZ chat context:\n${chat}` : '',
    readContextFiles(task.repoPath),
    `Rules:`,
    `- Work only inside the provided worktree.`,
    `- Make focused changes for the task. Do not read or expose .env files or secrets.`,
    `- Run reasonable verification before finishing.`,
    `- When complete, write this exact JSON file: ${markerPath}`,
    `- JSON shape: {"summary":"short summary","files_changed":["relative/path"],"notes":null}`,
    `- If no code changes are needed, still write the marker with an empty files_changed array and explain why in summary.`,
  ].filter(Boolean).join('\n\n')
}

function emitCodexEvent(line: string, onEvent: EventCallback): void {
  if (!line.trim()) return
  try {
    const event = JSON.parse(line) as Record<string, unknown>
    const type = String(event.type ?? event.event ?? '')
    const message = String(event.message ?? event.text ?? event.delta ?? '')
    if (type.includes('tool')) onEvent({ type: 'tool_call', message: message || type, data: { runner: 'codex' } })
    else if (message) onEvent({ type: 'thinking', message })
  } catch {
    onEvent({ type: 'thinking', message: line.slice(0, 300) })
  }
}

export async function runAgent(task: AgentTask, onEvent: EventCallback, signal?: AbortSignal): Promise<void> {
  const isSubAgent = Boolean(task.existingWorktree)
  const worktreePath = task.existingWorktree ?? setupWorktree(task.repoPath, task.branch, task.baseBranch ?? 'master')
  if (!isSubAgent) saveWorktreePath(task.taskId, worktreePath)

  const prompt = buildPrompt(task, worktreePath)
  const markerPath = path.join(worktreePath, '.raziel-completion.json')
  onEvent({ type: 'thinking', message: `Starting Codex runner in ${path.basename(worktreePath)}` })

  try {
    await new Promise<void>((resolve, reject) => {
      const args = ['exec', '--json', '--sandbox', 'workspace-write', '--ask-for-approval', 'never', '-C', worktreePath, '-']
      const model = process.env.RAZ_CODEX_MODEL
      if (model) args.splice(1, 0, '--model', model)

      const proc = spawn(codexCommand(), args, {
        cwd: worktreePath,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      })
      if (signal?.aborted) proc.kill('SIGTERM')
      signal?.addEventListener('abort', () => proc.kill('SIGTERM'), { once: true })

      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        const lines = stdout.split('\n')
        stdout = lines.pop() ?? ''
        for (const line of lines) emitCodexEvent(line, onEvent)
      })
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      proc.on('error', reject)
      proc.on('close', (code) => {
        if (stdout.trim()) emitCodexEvent(stdout, onEvent)
        if (code && !signal?.aborted) reject(new Error(stderr.trim() || `Codex exited with code ${code}`))
        else resolve()
      })
      proc.stdin.write(prompt)
      proc.stdin.end()
    })

    if (!fs.existsSync(markerPath)) {
      onEvent({ type: 'error', message: 'Codex finished without writing .raziel-completion.json.' })
      return
    }

    const completion = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as CompletionMarker
    fs.unlinkSync(markerPath)
    const committed = isSubAgent ? false : commitChanges(worktreePath, completion.summary, task.workflow, ROLES[task.role ?? DEFAULT_ROLE].commitPrefix)
    onEvent({
      type:    'complete',
      message: completion.summary,
      data:    { files_changed: completion.files_changed, notes: completion.notes, branch: task.branch, isSubAgent, commit_skipped: !committed },
    })
  } catch (err) {
    onEvent({ type: 'error', message: `Codex runner error: ${err}` })
  } finally {
    if (!isSubAgent) {
      clearWorktreePath(task.taskId)
      cleanupWorktree(task.repoPath, worktreePath)
    }
  }
}
