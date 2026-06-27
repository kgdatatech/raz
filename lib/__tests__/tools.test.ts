/**
 * Tests for lib/tools.ts — executeTool() dispatch and helper logic.
 *
 * Covers:
 *  - isBlockedPath() behavior (via read_file / write_file / security_scan)
 *  - isAllowedCommand() behavior (via execute_bash)
 *  - Path-traversal guards in read_file, write_file, list_directory, validate_migration
 *  - File I/O: read, write, list, truncation
 *  - SECRET_PATTERNS matching in security_scan
 *  - DANGEROUS SQL patterns in validate_migration
 *  - Shell command routing and error handling
 *  - GitHub tool routing (no-context guard + full happy-path)
 *  - PR verdict mapping in post_pr_review
 *  - Planning / memory tool routing (create_plan, save_memory)
 *  - generate_report file creation and memory persistence
 *  - delegate_to_role / handoff_to_role context availability guards
 *  - task_complete and unknown-tool default branch
 */

import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import os from 'os'
import fs from 'fs'
import path from 'path'

// ── DB path must be set before any import resolves lib/db ───────────────────
vi.hoisted(() => {
  process.env['RAZ_DB_PATH'] = ':memory:'
})

// ── Module mocks (hoisted before all imports) ───────────────────────────────

vi.mock('../db', () => ({
  getConfig:  vi.fn().mockReturnValue(null),   // null → not paused
  setMemory:  vi.fn(),
  savePlan:   vi.fn(),
}))

vi.mock('../github', () => ({
  fetchIssue:     vi.fn().mockResolvedValue('Issue #1: Bug report'),
  listOpenIssues: vi.fn().mockResolvedValue('2 open issues'),
  listOpenPRs:    vi.fn().mockResolvedValue('1 open PR'),
  getPRDetails:   vi.fn().mockResolvedValue({
    number:    7,
    title:     'Add tests',
    state:     'open',
    merged:    false,
    ciStatus:  'pending',
    approvals: 1,
    author:    'dev',
    createdAt: '2026-06-01T00:00:00Z',
    body:      'Adds comprehensive tests.',
    files:     [{ filename: 'lib/foo.ts', status: 'modified', additions: 10, deletions: 3 }],
    comments:  [{ author: 'reviewer', body: 'LGTM!' }],
  }),
  getPRFileDiff:  vi.fn().mockResolvedValue('+const x = 1\n-const x = 0'),
  createPRReview: vi.fn().mockResolvedValue('Review submitted'),
}))

// exec is promisified at module level in tools.ts; mock it here so promisify
// wraps our vi.fn() — resolved value is the object passed as cb's 2nd arg.
vi.mock('child_process', () => ({ exec: vi.fn() }))

import { exec } from 'child_process'
import { executeTool, type ToolContext } from '../tools'
import { getConfig, setMemory, savePlan } from '../db'
import {
  fetchIssue, listOpenIssues, listOpenPRs,
  getPRDetails, getPRFileDiff, createPRReview,
} from '../github'

// ── Temp directory for file I/O tests ───────────────────────────────────────

let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'razqa-tools-'))
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  // Clear call history but preserve factory-set mockReturnValues / mockResolvedValues.
  vi.clearAllMocks()
  // Ensure waitWhilePaused() exits immediately for every test.
  vi.mocked(getConfig).mockReturnValue(null)
})

// ── Context factories ────────────────────────────────────────────────────────

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { worktreePath: tmpDir, ...overrides }
}

function githubCtx(): ToolContext {
  return ctx({ github: { owner: 'owner', repo: 'repo' } })
}

// ── exec mock helpers ────────────────────────────────────────────────────────
// promisify(exec) calls exec(cmd, opts, callback) where callback is (err, result).
// Without the custom promisify symbol on our vi.fn(), the resolved value is
// whatever is passed as the second arg to the callback — so we pass { stdout, stderr }.

function mockExecOk(stdout = '', stderr = ''): void {
  vi.mocked(exec).mockImplementation(((
    _cmd: string,
    _opts: unknown,
    cb: (err: null, result: { stdout: string; stderr: string }) => void,
  ) => {
    cb(null, { stdout, stderr })
  }) as unknown as typeof exec)
}

function mockExecFail(stderr = 'command failed', stdout = ''): void {
  vi.mocked(exec).mockImplementation(((
    _cmd: string,
    _opts: unknown,
    cb: (err: Error & { stdout?: string; stderr?: string }) => void,
  ) => {
    const err = Object.assign(new Error(stderr), { stdout, stderr })
    cb(err)
  }) as unknown as typeof exec)
}

// ═══════════════════════════════════════════════════════════════════════════
// read_file
// ═══════════════════════════════════════════════════════════════════════════

describe('read_file', () => {
  it('blocks .env', async () => {
    const r = await executeTool('read_file', { path: '.env' }, ctx())
    expect(r).toBe('ERROR: Access to this file is blocked for security.')
  })

  it('blocks .env.local', async () => {
    const r = await executeTool('read_file', { path: '.env.local' }, ctx())
    expect(r).toBe('ERROR: Access to this file is blocked for security.')
  })

  it('blocks .env.production', async () => {
    const r = await executeTool('read_file', { path: '.env.production' }, ctx())
    expect(r).toBe('ERROR: Access to this file is blocked for security.')
  })

  it('blocks secrets file', async () => {
    const r = await executeTool('read_file', { path: 'secrets' }, ctx())
    expect(r).toBe('ERROR: Access to this file is blocked for security.')
  })

  it('blocks .pem files', async () => {
    const r = await executeTool('read_file', { path: 'server.pem' }, ctx())
    expect(r).toBe('ERROR: Access to this file is blocked for security.')
  })

  it('blocks .key files', async () => {
    const r = await executeTool('read_file', { path: 'private.key' }, ctx())
    expect(r).toBe('ERROR: Access to this file is blocked for security.')
  })

  it('blocks path traversal', async () => {
    const r = await executeTool('read_file', { path: '../../../etc/passwd' }, ctx())
    expect(r).toBe('ERROR: Path traversal not allowed.')
  })

  it('reads a real file and returns its content', async () => {
    fs.writeFileSync(path.join(tmpDir, 'hello.ts'), 'export const hello = 1')
    const r = await executeTool('read_file', { path: 'hello.ts' }, ctx())
    expect(r).toBe('export const hello = 1')
  })

  it('truncates files over 6000 chars and includes a truncation notice', async () => {
    fs.writeFileSync(path.join(tmpDir, 'bigfile.ts'), 'x'.repeat(7_000))
    const r = await executeTool('read_file', { path: 'bigfile.ts' }, ctx())
    expect(r).toContain('[FILE TRUNCATED')
    expect(r.length).toBeLessThan(7_000)
  })

  it('returns error when file does not exist', async () => {
    const r = await executeTool('read_file', { path: 'nonexistent.ts' }, ctx())
    expect(r).toContain('ERROR: Could not read file:')
  })

  it('reads files in nested subdirectories', async () => {
    const sub = path.join(tmpDir, 'nested', 'dir')
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(path.join(sub, 'nested.ts'), 'nested content')
    const r = await executeTool('read_file', { path: 'nested/dir/nested.ts' }, ctx())
    expect(r).toBe('nested content')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// write_file
// ═══════════════════════════════════════════════════════════════════════════

describe('write_file', () => {
  it('blocks writing to .env', async () => {
    const r = await executeTool('write_file', { path: '.env', content: 'SECRET=x' }, ctx())
    expect(r).toBe('ERROR: Cannot write to this file.')
  })

  it('blocks writing to id_rsa', async () => {
    const r = await executeTool('write_file', { path: 'id_rsa', content: '...' }, ctx())
    expect(r).toBe('ERROR: Cannot write to this file.')
  })

  it('blocks writing to id_ed25519', async () => {
    const r = await executeTool('write_file', { path: 'id_ed25519', content: '...' }, ctx())
    expect(r).toBe('ERROR: Cannot write to this file.')
  })

  it('blocks path traversal on write', async () => {
    const r = await executeTool('write_file', { path: '../../evil.sh', content: 'rm -rf' }, ctx())
    expect(r).toBe('ERROR: Path traversal not allowed.')
  })

  it('writes file and returns OK', async () => {
    const r = await executeTool('write_file', { path: 'output.ts', content: 'const x = 1' }, ctx())
    expect(r).toBe('OK: Written output.ts')
    expect(fs.readFileSync(path.join(tmpDir, 'output.ts'), 'utf-8')).toBe('const x = 1')
  })

  it('creates parent directories as needed', async () => {
    const r = await executeTool('write_file', { path: 'deep/sub/dir/file.ts', content: 'ok' }, ctx())
    expect(r).toBe('OK: Written deep/sub/dir/file.ts')
    expect(fs.existsSync(path.join(tmpDir, 'deep/sub/dir/file.ts'))).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// list_directory
// ═══════════════════════════════════════════════════════════════════════════

describe('list_directory', () => {
  it('blocks path traversal', async () => {
    const r = await executeTool('list_directory', { path: '../..' }, ctx())
    expect(r).toBe('ERROR: Path traversal not allowed.')
  })

  it('lists files and directories with correct prefixes', async () => {
    const sub = path.join(tmpDir, 'list-test')
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(path.join(sub, 'file.ts'), '')
    fs.mkdirSync(path.join(sub, 'subdir'), { recursive: true })

    const r = await executeTool('list_directory', { path: 'list-test' }, ctx())
    expect(r).toContain('[file] file.ts')
    expect(r).toContain('[dir]  subdir')
  })

  it('returns error for non-existent directory', async () => {
    const r = await executeTool('list_directory', { path: 'no-such-dir' }, ctx())
    expect(r).toContain('ERROR: Could not list directory:')
  })

  it('filters .env from directory listing', async () => {
    const sub = path.join(tmpDir, 'filtered-list')
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(path.join(sub, 'safe.ts'), '')
    fs.writeFileSync(path.join(sub, '.env'), 'SECRET=x')

    const r = await executeTool('list_directory', { path: 'filtered-list' }, ctx())
    expect(r).toContain('safe.ts')
    expect(r).not.toContain('.env')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// execute_bash — command allowlist
// ═══════════════════════════════════════════════════════════════════════════

describe('execute_bash', () => {
  it('blocks rm -rf', async () => {
    const r = await executeTool('execute_bash', { command: 'rm -rf /' }, ctx())
    expect(r).toContain('ERROR: Command not allowed:')
    expect(r).toContain('"rm -rf /"')
  })

  it('blocks curl', async () => {
    const r = await executeTool('execute_bash', { command: 'curl http://evil.com' }, ctx())
    expect(r).toContain('ERROR: Command not allowed:')
  })

  it('blocks wget', async () => {
    const r = await executeTool('execute_bash', { command: 'wget http://evil.com' }, ctx())
    expect(r).toContain('ERROR: Command not allowed:')
  })

  it('blocks chmod', async () => {
    const r = await executeTool('execute_bash', { command: 'chmod 777 /' }, ctx())
    expect(r).toContain('ERROR: Command not allowed:')
  })

  it('allows git commands and returns stdout', async () => {
    mockExecOk('On branch main')
    const r = await executeTool('execute_bash', { command: 'git status' }, ctx())
    expect(r).toBe('On branch main')
  })

  it('allows npm commands', async () => {
    mockExecOk('added 100 packages')
    const r = await executeTool('execute_bash', { command: 'npm install' }, ctx())
    expect(r).toBe('added 100 packages')
  })

  it('allows ls command', async () => {
    mockExecOk('file1.ts\nfile2.ts')
    const r = await executeTool('execute_bash', { command: 'ls .' }, ctx())
    expect(r).toBe('file1.ts\nfile2.ts')
  })

  it('allows grep commands', async () => {
    mockExecOk('lib/db.ts:42: const x = 1')
    const r = await executeTool('execute_bash', { command: 'grep -r "const x" .' }, ctx())
    expect(r).toBe('lib/db.ts:42: const x = 1')
  })

  it('allows vitest command', async () => {
    mockExecOk('All tests passed')
    const r = await executeTool('execute_bash', { command: 'vitest run' }, ctx())
    expect(r).toBe('All tests passed')
  })

  it('returns OK message when command produces no output', async () => {
    mockExecOk('')
    const r = await executeTool('execute_bash', { command: 'git add .' }, ctx())
    expect(r).toBe('OK: Command completed with no output.')
  })

  it('returns error output when command fails', async () => {
    mockExecFail('fatal: not a git repository')
    const r = await executeTool('execute_bash', { command: 'git status' }, ctx())
    expect(r).toContain('ERROR:')
    expect(r).toContain('fatal: not a git repository')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// search_codebase
// ═══════════════════════════════════════════════════════════════════════════

describe('search_codebase', () => {
  it('returns matches from grep output', async () => {
    mockExecOk('lib/tools.ts:42:const x = 1')
    const r = await executeTool('search_codebase', { pattern: 'const x' }, ctx())
    expect(r).toBe('lib/tools.ts:42:const x = 1')
  })

  it('returns no-match message when grep finds nothing', async () => {
    mockExecFail('', '')   // grep exits 1 with empty stdout when no matches
    const r = await executeTool('search_codebase', { pattern: 'zzznomatch' }, ctx())
    expect(r).toContain('No matches found for:')
    expect(r).toContain('zzznomatch')
  })

  it('caps context_lines at 5 regardless of input', async () => {
    mockExecOk('match')
    await executeTool('search_codebase', { pattern: 'x', context_lines: 10 }, ctx())
    const calledCmd = (vi.mocked(exec).mock.calls[0] as [string, ...unknown[]])[0]
    expect(calledCmd).toContain('-C 5')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// get_diff
// ═══════════════════════════════════════════════════════════════════════════

describe('get_diff', () => {
  it('returns stat and diff when stat_only is not set', async () => {
    mockExecOk('lib/tools.ts | 5 ++++\n 1 file changed')
    const r = await executeTool('get_diff', {}, ctx())
    expect(r).toContain('1 file changed')
  })

  it('returns only the stat line when stat_only=true', async () => {
    mockExecOk('lib/tools.ts | 5 ++++\n 1 file changed')
    const r = await executeTool('get_diff', { stat_only: true }, ctx())
    // Only one exec call (no second call for full diff)
    expect(vi.mocked(exec).mock.calls).toHaveLength(1)
    expect(r).toBe('lib/tools.ts | 5 ++++\n 1 file changed')
  })

  it('returns fallback message when exec throws', async () => {
    mockExecFail('not a git repository')
    const r = await executeTool('get_diff', {}, ctx())
    expect(r).toBe('No changes detected yet.')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// run_build
// ═══════════════════════════════════════════════════════════════════════════

describe('run_build', () => {
  it('returns no-build-config when worktree has no tsconfig or build script', async () => {
    // tmpDir has no tsconfig.json or package.json → both checks skip
    const r = await executeTool('run_build', {}, ctx())
    expect(r).toBe('No build configuration found (no tsconfig.json or build script).')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// run_tests
// ═══════════════════════════════════════════════════════════════════════════

describe('run_tests', () => {
  it('returns no-suite message when package.json has no test script', async () => {
    const r = await executeTool('run_tests', {}, ctx())
    expect(r).toBe('No test suite configured in package.json.')
  })

  it('returns no-suite message for the default echo test script', async () => {
    const pkgPath = path.join(tmpDir, 'package.json')
    fs.writeFileSync(pkgPath, JSON.stringify({
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
    }))
    const r = await executeTool('run_tests', {}, ctx())
    expect(r).toBe('No test suite configured in package.json.')
    fs.unlinkSync(pkgPath)
  })

  it('appends filter to the test command when provided', async () => {
    const pkgPath = path.join(tmpDir, 'package.json')
    fs.writeFileSync(pkgPath, JSON.stringify({ scripts: { test: 'vitest run' } }))
    mockExecOk('1 test passed')
    await executeTool('run_tests', { filter: 'my-specific-test' }, ctx())
    const calledCmd = (vi.mocked(exec).mock.calls[0] as [string, ...unknown[]])[0]
    expect(calledCmd).toContain('my-specific-test')
    fs.unlinkSync(pkgPath)
  })

  it('returns TESTS FAILED output when the test command exits non-zero', async () => {
    const pkgPath = path.join(tmpDir, 'package.json')
    fs.writeFileSync(pkgPath, JSON.stringify({ scripts: { test: 'vitest run' } }))
    mockExecFail('2 tests failed')
    const r = await executeTool('run_tests', {}, ctx())
    expect(r).toContain('TESTS FAILED:')
    fs.unlinkSync(pkgPath)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// run_lint
// ═══════════════════════════════════════════════════════════════════════════

describe('run_lint', () => {
  it('runs npm run lint when lint script is present and returns PASS on clean output', async () => {
    const pkgPath = path.join(tmpDir, 'package.json')
    fs.writeFileSync(pkgPath, JSON.stringify({ scripts: { lint: 'eslint .' } }))
    mockExecOk('')
    const r = await executeTool('run_lint', {}, ctx())
    expect(r).toBe('PASS — no lint errors')
    fs.unlinkSync(pkgPath)
  })

  it('falls back to npx eslint when no lint script is configured', async () => {
    mockExecOk('No issues found')
    await executeTool('run_lint', {}, ctx())
    const calledCmd = (vi.mocked(exec).mock.calls[0] as [string, ...unknown[]])[0]
    expect(calledCmd).toContain('npx eslint')
  })

  it('returns LINT ERRORS when linting fails', async () => {
    mockExecFail('3 errors found')
    const r = await executeTool('run_lint', {}, ctx())
    expect(r).toContain('LINT ERRORS:')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// create_plan
// ═══════════════════════════════════════════════════════════════════════════

describe('create_plan', () => {
  it('returns OK and echoes the plan text', async () => {
    const r = await executeTool(
      'create_plan',
      { plan: 'Step 1: Do X\nStep 2: Do Y' },
      ctx({ taskId: 'task-abc' }),
    )
    expect(r).toContain('OK: Plan recorded.')
    expect(r).toContain('Step 1: Do X')
  })

  it('calls savePlan with the taskId and plan text', async () => {
    await executeTool('create_plan', { plan: 'My plan' }, ctx({ taskId: 'task-xyz' }))
    expect(vi.mocked(savePlan)).toHaveBeenCalledWith('task-xyz', 'My plan')
  })

  it('skips savePlan when no taskId is in context', async () => {
    await executeTool('create_plan', { plan: 'Orphan plan' }, ctx())
    expect(vi.mocked(savePlan)).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// save_memory
// ═══════════════════════════════════════════════════════════════════════════

describe('save_memory', () => {
  it('calls setMemory with repoId, key, and value', async () => {
    await executeTool(
      'save_memory',
      { key: 'db:pattern', value: 'migrations are additive' },
      ctx({ repoId: 42 }),
    )
    expect(vi.mocked(setMemory)).toHaveBeenCalledWith(42, 'db:pattern', 'migrations are additive')
  })

  it('returns a success message containing the key', async () => {
    const r = await executeTool(
      'save_memory',
      { key: 'arch:note', value: 'important' },
      ctx({ repoId: 1 }),
    )
    expect(r).toContain('OK: Memory saved')
    expect(r).toContain('arch:note')
  })

  it('skips setMemory when no repoId in context', async () => {
    const r = await executeTool('save_memory', { key: 'k', value: 'v' }, ctx())
    expect(vi.mocked(setMemory)).not.toHaveBeenCalled()
    expect(r).toContain('skipped')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// security_scan
// ═══════════════════════════════════════════════════════════════════════════

describe('security_scan', () => {
  it('returns CLEAN when git diff reports no changed files', async () => {
    mockExecOk('')   // git diff --name-only returns empty string
    const r = await executeTool('security_scan', {}, ctx())
    expect(r).toBe('CLEAN: No changed files to scan.')
  })

  it('returns CLEAN when changed file contains no secrets', async () => {
    fs.writeFileSync(path.join(tmpDir, 'clean.ts'), 'export const x = 1')
    mockExecOk('clean.ts')
    const r = await executeTool('security_scan', {}, ctx())
    expect(r).toContain('CLEAN:')
    expect(r).toContain('no secrets')
  })

  it('detects an Anthropic API key', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'leak-ant.ts'),
      'const key = "sk-ant-api03-aaaabbbbccccddddeeeeffffgggghhhhiiiijjjj"',
    )
    mockExecOk('leak-ant.ts')
    const r = await executeTool('security_scan', {}, ctx())
    expect(r).toContain('SECURITY ALERT')
    expect(r).toContain('Anthropic API Key')
    expect(r).toContain('leak-ant.ts')
  })

  it('detects a GitHub PAT', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'leak-gh.ts'),
      'const token = "ghp_ABCDefghIJKLmnopQRSTuvwxYZ123456abcd"',
    )
    mockExecOk('leak-gh.ts')
    const r = await executeTool('security_scan', {}, ctx())
    expect(r).toContain('SECURITY ALERT')
    expect(r).toContain('GitHub PAT')
  })

  it('detects an AWS Access Key', async () => {
    fs.writeFileSync(path.join(tmpDir, 'leak-aws.ts'), 'const k = "AKIAIOSFODNN7EXAMPLE"')
    mockExecOk('leak-aws.ts')
    const r = await executeTool('security_scan', {}, ctx())
    expect(r).toContain('SECURITY ALERT')
    expect(r).toContain('AWS Access Key')
  })

  it('detects a hardcoded password', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'leak-pwd.ts'),
      "const config = { password: 'supersecret123' }",
    )
    mockExecOk('leak-pwd.ts')
    const r = await executeTool('security_scan', {}, ctx())
    expect(r).toContain('SECURITY ALERT')
    expect(r).toContain('Hardcoded Password')
  })

  it('detects a DB connection string', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'leak-db.ts'),
      'const url = "postgres://admin:p4ssw0rd@db.example.com/mydb"',
    )
    mockExecOk('leak-db.ts')
    const r = await executeTool('security_scan', {}, ctx())
    expect(r).toContain('SECURITY ALERT')
    expect(r).toContain('DB Connection String')
  })

  it('skips blocked paths (.env) during scan even when they contain secrets', async () => {
    // Create .env with a real secret — must be skipped by isBlockedPath check
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      'ANTHROPIC_API_KEY=sk-ant-api03-aaaabbbbccccddddeeeeffffgggghhhhiiiijjjj',
    )
    mockExecOk('.env')
    const r = await executeTool('security_scan', {}, ctx())
    expect(r).toContain('CLEAN:')
  })

  it('falls back to git ls-files when git diff fails (no commits yet)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'clean-ls.ts'), 'export const y = 2')
    // First call (git diff) fails; second call (git ls-files) succeeds
    vi.mocked(exec)
      .mockImplementationOnce(((
        _cmd: string,
        _opts: unknown,
        cb: (err: Error) => void,
      ) => { cb(new Error('no commits yet')) }) as unknown as typeof exec)
      .mockImplementationOnce(((
        _cmd: string,
        _opts: unknown,
        cb: (err: null, r: { stdout: string; stderr: string }) => void,
      ) => { cb(null, { stdout: 'clean-ls.ts', stderr: '' }) }) as unknown as typeof exec)

    const r = await executeTool('security_scan', {}, ctx())
    expect(r).toContain('CLEAN:')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// validate_migration
// ═══════════════════════════════════════════════════════════════════════════

describe('validate_migration', () => {
  it('returns VALID for a clean migration with only safe statements', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mig-clean.sql'),
      'ALTER TABLE tasks ADD COLUMN foo TEXT;\nCREATE INDEX idx ON tasks(id);',
    )
    const r = await executeTool('validate_migration', { path: 'mig-clean.sql' }, ctx())
    expect(r).toContain('MIGRATION VALID:')
    expect(r).toContain('No dangerous patterns detected')
  })

  it('warns on DROP TABLE without IF EXISTS', async () => {
    fs.writeFileSync(path.join(tmpDir, 'mig-drop.sql'), 'DROP TABLE old_table;')
    const r = await executeTool('validate_migration', { path: 'mig-drop.sql' }, ctx())
    expect(r).toContain('MIGRATION WARNINGS')
    expect(r).toContain('DROP TABLE without IF EXISTS')
  })

  it('does NOT warn on DROP TABLE IF EXISTS', async () => {
    fs.writeFileSync(path.join(tmpDir, 'mig-drop-safe.sql'), 'DROP TABLE IF EXISTS old_table;')
    const r = await executeTool('validate_migration', { path: 'mig-drop-safe.sql' }, ctx())
    expect(r).toContain('MIGRATION VALID:')
  })

  it('warns on DELETE without WHERE', async () => {
    fs.writeFileSync(path.join(tmpDir, 'mig-del.sql'), 'DELETE FROM tasks;')
    const r = await executeTool('validate_migration', { path: 'mig-del.sql' }, ctx())
    expect(r).toContain('MIGRATION WARNINGS')
    expect(r).toContain('DELETE without WHERE clause')
  })

  it('does NOT warn on DELETE with WHERE', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mig-del-safe.sql'),
      "DELETE FROM tasks WHERE status = 'failed';",
    )
    const r = await executeTool('validate_migration', { path: 'mig-del-safe.sql' }, ctx())
    expect(r).toContain('MIGRATION VALID:')
  })

  it('warns on TRUNCATE', async () => {
    fs.writeFileSync(path.join(tmpDir, 'mig-trunc.sql'), 'TRUNCATE TABLE sessions;')
    const r = await executeTool('validate_migration', { path: 'mig-trunc.sql' }, ctx())
    expect(r).toContain('MIGRATION WARNINGS')
    expect(r).toContain('TRUNCATE')
  })

  it('warns on DROP DATABASE', async () => {
    fs.writeFileSync(path.join(tmpDir, 'mig-dropdb.sql'), 'DROP DATABASE mydb;')
    const r = await executeTool('validate_migration', { path: 'mig-dropdb.sql' }, ctx())
    expect(r).toContain('MIGRATION WARNINGS')
    expect(r).toContain('DROP DATABASE')
  })

  it('reports the correct count of multiple warnings', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mig-multi.sql'),
      'DROP TABLE old;\nTRUNCATE sessions;\nDELETE FROM tasks;',
    )
    const r = await executeTool('validate_migration', { path: 'mig-multi.sql' }, ctx())
    expect(r).toContain('MIGRATION WARNINGS')
    expect(r).toMatch(/3 issue\(s\)/)
  })

  it('blocks path traversal', async () => {
    const r = await executeTool('validate_migration', { path: '../../secret.sql' }, ctx())
    expect(r).toBe('ERROR: Path traversal not allowed.')
  })

  it('returns error when migration file does not exist', async () => {
    const r = await executeTool('validate_migration', { path: 'missing.sql' }, ctx())
    expect(r).toContain('ERROR: Could not read migration file:')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// generate_report
// ═══════════════════════════════════════════════════════════════════════════

describe('generate_report', () => {
  let mkdirSpy: ReturnType<typeof vi.spyOn>
  let writeSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined)
    writeSpy  = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined)
  })

  afterEach(() => {
    // Restore only the fs spies — vi.restoreAllMocks() would also nuke the
    // factory-set mockResolvedValues on the github module mocks.
    mkdirSpy.mockRestore()
    writeSpy.mockRestore()
  })

  it('returns a preview of the generated report', async () => {
    const r = await executeTool(
      'generate_report',
      { title: 'Test Report', summary: 'All good.', findings: 'No issues found.' },
      ctx({ repoId: 1 }),
    )
    expect(r).toContain('OK: Report saved to .raziel/reports/')
    expect(r).toContain('Preview:')
    expect(r).toContain('# Test Report')
  })

  it('creates the .raziel/reports directory', async () => {
    await executeTool(
      'generate_report',
      { title: 'Dir Test', summary: 'S', findings: 'F' },
      ctx(),
    )
    expect(mkdirSpy).toHaveBeenCalledWith(
      expect.stringContaining('.raziel'),
      expect.objectContaining({ recursive: true }),
    )
  })

  it('writes a markdown file containing the title and findings', async () => {
    await executeTool(
      'generate_report',
      { title: 'Write Test', summary: 'Sum', findings: 'Key findings here' },
      ctx(),
    )
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('.md'),
      expect.stringContaining('# Write Test'),
      'utf-8',
    )
    expect(writeSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Key findings here'),
      'utf-8',
    )
  })

  it('slugifies the title in the output filename', async () => {
    await executeTool(
      'generate_report',
      { title: 'My Fancy Report!', summary: 'S', findings: 'F' },
      ctx(),
    )
    const writtenPath = (writeSpy.mock.calls[0] as [string])[0]
    expect(writtenPath).toContain('my-fancy-report')
  })

  it('saves a memory entry when repoId is provided', async () => {
    await executeTool(
      'generate_report',
      { title: 'Memory Test', summary: 'Save me.', findings: 'Details.' },
      ctx({ repoId: 99 }),
    )
    expect(vi.mocked(setMemory)).toHaveBeenCalledWith(
      99,
      expect.stringContaining('memory-test'),
      expect.stringContaining('Save me.'),
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// dependency_audit
// ═══════════════════════════════════════════════════════════════════════════

describe('dependency_audit', () => {
  it('returns DEPENDENCY AUDIT with output on success', async () => {
    mockExecOk('found 0 vulnerabilities')
    const r = await executeTool('dependency_audit', {}, ctx())
    expect(r).toContain('DEPENDENCY AUDIT:')
    expect(r).toContain('found 0 vulnerabilities')
  })

  it('returns vulnerabilities-found prefix when audit exits non-zero', async () => {
    mockExecFail('', '3 high severity vulnerabilities found')
    const r = await executeTool('dependency_audit', {}, ctx())
    expect(r).toContain('DEPENDENCY AUDIT (vulnerabilities found):')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// check_coverage
// ═══════════════════════════════════════════════════════════════════════════

describe('check_coverage', () => {
  it('returns no-suite message when package.json has no test script', async () => {
    const r = await executeTool('check_coverage', {}, ctx())
    expect(r).toBe('No test suite configured in package.json.')
  })

  it('returns COVERAGE block when tests and coverage run successfully', async () => {
    const pkgPath = path.join(tmpDir, 'package.json')
    fs.writeFileSync(pkgPath, JSON.stringify({ scripts: { test: 'vitest run' } }))
    mockExecOk('Stmts | Branches | Funcs | Lines\n100% | 90% | 95% | 100%')
    const r = await executeTool('check_coverage', {}, ctx())
    expect(r).toContain('COVERAGE:')
    fs.unlinkSync(pkgPath)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// GitHub tools — no-context guard
// ═══════════════════════════════════════════════════════════════════════════

describe('GitHub tools without github context', () => {
  const noCtx = ctx()   // no github property

  it('fetch_issue returns error', async () => {
    expect(await executeTool('fetch_issue', { number: 1 }, noCtx))
      .toBe('ERROR: No GitHub context available.')
  })

  it('list_issues returns error', async () => {
    expect(await executeTool('list_issues', {}, noCtx))
      .toBe('ERROR: No GitHub context available.')
  })

  it('list_open_prs returns error', async () => {
    expect(await executeTool('list_open_prs', {}, noCtx))
      .toBe('ERROR: No GitHub context available.')
  })

  it('get_pr_summary returns error', async () => {
    expect(await executeTool('get_pr_summary', { pr_number: 1 }, noCtx))
      .toBe('ERROR: No GitHub context available.')
  })

  it('get_pr_file_diff returns error', async () => {
    expect(await executeTool('get_pr_file_diff', { pr_number: 1, filename: 'lib/foo.ts' }, noCtx))
      .toBe('ERROR: No GitHub context available.')
  })

  it('post_pr_review returns error', async () => {
    expect(await executeTool('post_pr_review', { pr_number: 1, body: 'ok', verdict: 'approve' }, noCtx))
      .toBe('ERROR: No GitHub context available.')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// GitHub tools — happy path (with context)
// ═══════════════════════════════════════════════════════════════════════════

describe('GitHub tools with context', () => {
  it('fetch_issue delegates to fetchIssue with owner, repo, number', async () => {
    const r = await executeTool('fetch_issue', { number: 42 }, githubCtx())
    expect(vi.mocked(fetchIssue)).toHaveBeenCalledWith('owner', 'repo', 42)
    expect(r).toBe('Issue #1: Bug report')
  })

  it('fetch_issue returns error string when GitHub throws', async () => {
    vi.mocked(fetchIssue).mockRejectedValueOnce(new Error('Rate limited'))
    const r = await executeTool('fetch_issue', { number: 1 }, githubCtx())
    expect(r).toContain('ERROR: Could not fetch issue:')
  })

  it('list_issues passes limit to listOpenIssues', async () => {
    vi.mocked(listOpenIssues).mockResolvedValue('5 open issues')
    const r = await executeTool('list_issues', { limit: 5 }, githubCtx())
    expect(vi.mocked(listOpenIssues)).toHaveBeenCalledWith('owner', 'repo', 5)
    expect(r).toBe('5 open issues')
  })

  it('list_issues defaults to limit 20', async () => {
    await executeTool('list_issues', {}, githubCtx())
    expect(vi.mocked(listOpenIssues)).toHaveBeenCalledWith('owner', 'repo', 20)
  })

  it('list_open_prs calls listOpenPRs', async () => {
    const r = await executeTool('list_open_prs', {}, githubCtx())
    expect(vi.mocked(listOpenPRs)).toHaveBeenCalledWith('owner', 'repo')
    expect(r).toBe('1 open PR')
  })

  it('get_pr_summary formats PR details correctly', async () => {
    const r = await executeTool('get_pr_summary', { pr_number: 7 }, githubCtx())
    expect(vi.mocked(getPRDetails)).toHaveBeenCalledWith('owner', 'repo', 7)
    expect(r).toContain('PR #7: Add tests')
    expect(r).toContain('State: open')
    expect(r).toContain('lib/foo.ts')
    expect(r).toContain('LGTM!')
  })

  it('get_pr_summary shows (merged) for merged PRs', async () => {
    vi.mocked(getPRDetails).mockResolvedValueOnce({
      number: 3, title: 'Merged PR', state: 'closed', merged: true,
      ciStatus: 'success', approvals: 2, author: 'dev',
      createdAt: '2026-01-01T00:00:00Z', body: null, files: [], comments: [],
    })
    const r = await executeTool('get_pr_summary', { pr_number: 3 }, githubCtx())
    expect(r).toContain('(merged)')
  })

  it('get_pr_summary shows (none) when there are no comments', async () => {
    vi.mocked(getPRDetails).mockResolvedValueOnce({
      number: 5, title: 'No comments PR', state: 'open', merged: false,
      ciStatus: 'pending', approvals: 0, author: 'dev',
      createdAt: '2026-01-01T00:00:00Z', body: 'desc', files: [], comments: [],
    })
    const r = await executeTool('get_pr_summary', { pr_number: 5 }, githubCtx())
    expect(r).toContain('(none)')
  })

  it('get_pr_file_diff delegates to getPRFileDiff', async () => {
    const r = await executeTool('get_pr_file_diff', { pr_number: 7, filename: 'lib/foo.ts' }, githubCtx())
    expect(vi.mocked(getPRFileDiff)).toHaveBeenCalledWith('owner', 'repo', 7, 'lib/foo.ts')
    expect(r).toBe('+const x = 1\n-const x = 0')
  })

  it('post_pr_review maps "approve" → APPROVE', async () => {
    const r = await executeTool(
      'post_pr_review',
      { pr_number: 7, body: 'All good', verdict: 'approve' },
      githubCtx(),
    )
    expect(vi.mocked(createPRReview)).toHaveBeenCalledWith('owner', 'repo', 7, 'All good', 'APPROVE')
    expect(r).toBe('Review submitted')
  })

  it('post_pr_review maps "request_changes" → REQUEST_CHANGES', async () => {
    await executeTool(
      'post_pr_review',
      { pr_number: 7, body: 'Fix X', verdict: 'request_changes' },
      githubCtx(),
    )
    expect(vi.mocked(createPRReview)).toHaveBeenCalledWith('owner', 'repo', 7, 'Fix X', 'REQUEST_CHANGES')
  })

  it('post_pr_review maps "comment" → COMMENT', async () => {
    await executeTool(
      'post_pr_review',
      { pr_number: 7, body: 'FYI', verdict: 'comment' },
      githubCtx(),
    )
    expect(vi.mocked(createPRReview)).toHaveBeenCalledWith('owner', 'repo', 7, 'FYI', 'COMMENT')
  })

  it('post_pr_review defaults to COMMENT for unknown verdict', async () => {
    await executeTool(
      'post_pr_review',
      { pr_number: 7, body: 'hmm', verdict: 'unknown_verdict' },
      githubCtx(),
    )
    expect(vi.mocked(createPRReview)).toHaveBeenCalledWith('owner', 'repo', 7, 'hmm', 'COMMENT')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// delegate_to_role
// ═══════════════════════════════════════════════════════════════════════════

describe('delegate_to_role', () => {
  it('returns error when runSubAgent is not in context', async () => {
    const r = await executeTool('delegate_to_role', { role: 'RAZ-Sec', task: 'audit changes' }, ctx())
    expect(r).toBe('ERROR: Delegation not available in this context.')
  })

  it('calls runSubAgent with role, task description, and workflow', async () => {
    const runSubAgent = vi.fn().mockResolvedValue('Delegation done')
    const r = await executeTool(
      'delegate_to_role',
      { role: 'RAZ-QA', task: 'write tests', workflow: 'test' },
      ctx({ runSubAgent, parentRole: 'RAZ-Dev' }),
    )
    expect(runSubAgent).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'RAZ-QA', workflow: 'test' }),
    )
    expect(r).toContain('DELEGATION COMPLETE:')
    expect(r).toContain('Delegation done')
  })

  it('appends context and parentRole to the task description', async () => {
    const runSubAgent = vi.fn().mockResolvedValue('ok')
    await executeTool(
      'delegate_to_role',
      { role: 'RAZ-Sec', task: 'scan for secrets', context: 'Check lib/tools.ts' },
      ctx({ runSubAgent, parentRole: 'RAZ-Dev' }),
    )
    const description = (runSubAgent.mock.calls[0] as [{ description: string }])[0].description
    expect(description).toContain('Check lib/tools.ts')
    expect(description).toContain('RAZ-Dev')
  })

  it('returns DELEGATION FAILED when runSubAgent throws', async () => {
    const runSubAgent = vi.fn().mockRejectedValue(new Error('timeout'))
    const r = await executeTool('delegate_to_role', { role: 'RAZ-Sec', task: 'audit' }, ctx({ runSubAgent }))
    expect(r).toContain('DELEGATION FAILED:')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// handoff_to_role
// ═══════════════════════════════════════════════════════════════════════════

describe('handoff_to_role', () => {
  it('returns error when queueHandoff is not in context', async () => {
    const r = await executeTool('handoff_to_role', { role: 'RAZ-Ops', task: 'audit build' }, ctx())
    expect(r).toBe('ERROR: Handoff not available in this context.')
  })

  it('calls queueHandoff and includes task ID in response', async () => {
    const queueHandoff = vi.fn().mockResolvedValue('task-999')
    const r = await executeTool(
      'handoff_to_role',
      { role: 'RAZ-Ops', task: 'run build audit', workflow: 'audit', context: 'After feature' },
      ctx({ queueHandoff }),
    )
    expect(queueHandoff).toHaveBeenCalledWith({
      role: 'RAZ-Ops',
      description: 'run build audit',
      workflow: 'audit',
      context: 'After feature',
    })
    expect(r).toContain('HANDOFF QUEUED:')
    expect(r).toContain('task-999')
    expect(r).toContain('RAZ-Ops')
  })

  it('truncates task descriptions longer than 60 chars in the confirmation', async () => {
    const queueHandoff = vi.fn().mockResolvedValue('task-111')
    const longTask = 'A'.repeat(100)
    const r = await executeTool('handoff_to_role', { role: 'RAZ-Dev', task: longTask }, ctx({ queueHandoff }))
    expect(r).toContain('...')
    expect(r).toContain('A'.repeat(60))
    expect(r).not.toContain('A'.repeat(61))
  })

  it('returns HANDOFF FAILED when queueHandoff throws', async () => {
    const queueHandoff = vi.fn().mockRejectedValue(new Error('queue full'))
    const r = await executeTool('handoff_to_role', { role: 'RAZ-Ops', task: 'check' }, ctx({ queueHandoff }))
    expect(r).toContain('HANDOFF FAILED:')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// task_complete
// ═══════════════════════════════════════════════════════════════════════════

describe('task_complete', () => {
  it('returns COMPLETE: followed by the summary', async () => {
    const r = await executeTool(
      'task_complete',
      { summary: 'Added 10 tests for lib/tools.ts', files_changed: ['lib/__tests__/tools.test.ts'] },
      ctx(),
    )
    expect(r).toBe('COMPLETE: Added 10 tests for lib/tools.ts')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Unknown tool — default branch
// ═══════════════════════════════════════════════════════════════════════════

describe('unknown tool (default branch)', () => {
  it('returns ERROR: Unknown tool.', async () => {
    const r = await executeTool(
      'nonexistent_tool' as Parameters<typeof executeTool>[0],
      {},
      ctx(),
    )
    expect(r).toBe('ERROR: Unknown tool.')
  })
})
