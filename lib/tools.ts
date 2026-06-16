import fs from 'fs'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

// Commands the agent is allowed to run — anything not matching is blocked
const ALLOWED_COMMANDS = [
  /^git\s/,
  /^npm\s(install|run|test|build|list)/,
  /^npx\s/,
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
]

// Files/dirs the agent can never read
const BLOCKED_PATHS = [
  '.env', '.env.local', '.env.production', '.env.development',
  '.env.staging', 'secrets', '.secret',
]

function isBlockedPath(filePath: string): boolean {
  const base = path.basename(filePath)
  return BLOCKED_PATHS.some((b) => base === b || base.startsWith(b))
}

function isAllowedCommand(cmd: string): boolean {
  return ALLOWED_COMMANDS.some((pattern) => pattern.test(cmd.trim()))
}

export const TOOLS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file in the repo. Cannot read .env or secret files.',
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
    description: 'Write content to a file. Creates the file if it does not exist.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to repo root' },
        content: { type: 'string', description: 'Full file content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories at a path in the repo.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to repo root. Use "." for root.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'execute_bash',
    description: 'Run an allowlisted bash command in the repo worktree.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to run' },
      },
      required: ['command'],
    },
  },
  {
    name: 'task_complete',
    description: 'Signal that the task is complete and provide a summary of all changes made.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Summary of what was done and why' },
        files_changed: { type: 'array', items: { type: 'string' }, description: 'List of files created or modified' },
      },
      required: ['summary', 'files_changed'],
    },
  },
] as const

export type ToolName = 'read_file' | 'write_file' | 'list_directory' | 'execute_bash' | 'task_complete'

export async function executeTool(
  name: ToolName,
  input: Record<string, unknown>,
  worktreePath: string,
): Promise<string> {
  switch (name) {
    case 'read_file': {
      const filePath = path.join(worktreePath, input.path as string)
      if (isBlockedPath(input.path as string)) {
        return 'ERROR: Access to this file is blocked for security reasons.'
      }
      if (!filePath.startsWith(worktreePath)) {
        return 'ERROR: Path traversal not allowed.'
      }
      try {
        return fs.readFileSync(filePath, 'utf-8')
      } catch {
        return `ERROR: Could not read file: ${input.path}`
      }
    }

    case 'write_file': {
      const filePath = path.join(worktreePath, input.path as string)
      if (isBlockedPath(input.path as string)) {
        return 'ERROR: Cannot write to this file.'
      }
      if (!filePath.startsWith(worktreePath)) {
        return 'ERROR: Path traversal not allowed.'
      }
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, input.content as string, 'utf-8')
        return `OK: Written to ${input.path}`
      } catch (e) {
        return `ERROR: Could not write file: ${e}`
      }
    }

    case 'list_directory': {
      const dirPath = path.join(worktreePath, input.path as string)
      if (!dirPath.startsWith(worktreePath)) {
        return 'ERROR: Path traversal not allowed.'
      }
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })
        return entries
          .filter((e) => !BLOCKED_PATHS.includes(e.name))
          .map((e) => `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`)
          .join('\n')
      } catch {
        return `ERROR: Could not list directory: ${input.path}`
      }
    }

    case 'execute_bash': {
      const command = input.command as string
      if (!isAllowedCommand(command)) {
        return `ERROR: Command not allowed: "${command}". Only git, npm, find, grep, ls, cat, echo, mkdir, cp, mv, touch, node, tsc are permitted.`
      }
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: worktreePath,
          timeout: 30_000,
          env: { ...process.env, NODE_ENV: process.env.NODE_ENV },
        })
        return (stdout + stderr).trim() || 'OK: Command completed with no output.'
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string; message?: string }
        return `ERROR: ${err.stderr || err.stdout || err.message}`
      }
    }

    case 'task_complete': {
      return `COMPLETE: ${input.summary}`
    }

    default:
      return 'ERROR: Unknown tool.'
  }
}
