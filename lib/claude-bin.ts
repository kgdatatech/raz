import path from 'path'
import fs from 'fs'
import { execFileSync } from 'child_process'

// Candidate .exe paths to try in order on Windows
function candidateExePaths(appData: string | undefined, userProfile: string | undefined): string[] {
  return [
    // Claude Code desktop app (Windows installer)
    path.join(userProfile || 'C:\\Users\\Default', '.local', 'bin', 'claude.exe'),
    // npm global install
    path.join(appData || 'C:\\Users\\Default\\AppData\\Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    // Local AppData Programs
    path.join(process.env['LOCALAPPDATA'] || 'C:\\Users\\Default\\AppData\\Local', 'Programs', 'claude', 'claude.exe'),
  ]
}

let cachedExePath: string | null = null

export function clearClaudePathCache(): void { cachedExePath = null }

function resolveWin32ExePath(
  appData:     string | undefined,
  userProfile: string | undefined,
): string | null {
  if (cachedExePath !== null) return cachedExePath

  // Try known paths first (no subprocess needed)
  for (const p of candidateExePaths(appData, userProfile)) {
    if (fs.existsSync(p)) {
      cachedExePath = p
      return p
    }
  }

  // Fall back to `where claude` to find it via PATH
  try {
    const result = execFileSync('where', ['claude'], { encoding: 'utf8', timeout: 3_000 }).trim()
    const first  = result.split(/\r?\n/)[0]?.trim()
    if (first && fs.existsSync(first)) {
      cachedExePath = first
      return first
    }
  } catch {}

  return null
}

export function resolveClaudeBin(
  platform:    string = process.platform,
  appData:     string | undefined = process.env['APPDATA'],
): string {
  return platform === 'win32'
    ? path.join(appData || 'C:\\Users\\Default\\AppData\\Roaming', 'npm', 'claude.cmd')
    : 'claude'
}

export function resolveSpawnShell(platform: string = process.platform): boolean {
  return platform === 'win32'
}

export function resolveClaudeSpawn(
  claudeArgs:  string[],
  platform:    string = process.platform,
  appData:     string | undefined = process.env['APPDATA'],
  userProfile: string | undefined = process.env['USERPROFILE'],
): { exe: string; args: string[]; shell: boolean } {
  if (platform !== 'win32') {
    return { exe: 'claude', args: claudeArgs, shell: false }
  }

  const exePath = resolveWin32ExePath(appData, userProfile)
  if (exePath) {
    // Spawn .exe directly — bypasses cmd.exe so newlines and long args work correctly
    return { exe: exePath, args: claudeArgs, shell: false }
  }

  // Fall back to cmd.exe shell with claude.cmd — works wherever npm global bin is on PATH
  return { exe: 'claude', args: claudeArgs, shell: true }
}
