import path from 'path'

function claudeExePath(appData: string | undefined): string {
  return path.join(
    appData || 'C:\\Users\\Default\\AppData\\Roaming',
    'npm',
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  )
}

function claudeCmdPath(appData: string | undefined): string {
  return path.join(
    appData || 'C:\\Users\\Default\\AppData\\Roaming',
    'npm',
    'claude.cmd',
  )
}

export function resolveClaudeBin(
  platform: string = process.platform,
  appData:  string | undefined = process.env['APPDATA'],
): string {
  return platform === 'win32' ? claudeCmdPath(appData) : 'claude'
}

export function resolveSpawnShell(platform: string = process.platform): boolean {
  return platform === 'win32'
}

export function resolveClaudeSpawn(
  claudeArgs: string[],
  platform:   string = process.platform,
  appData:    string | undefined = process.env['APPDATA'],
): { exe: string; args: string[]; shell: false } {
  if (platform !== 'win32') {
    return { exe: 'claude', args: claudeArgs, shell: false }
  }
  // Spawn claude.exe directly — bypasses cmd.exe so newlines and long args work correctly
  return { exe: claudeExePath(appData), args: claudeArgs, shell: false }
}
