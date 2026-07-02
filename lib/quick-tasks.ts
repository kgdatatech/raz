import type { RoleId } from './roles'

export type RazMode = 'standard' | 'supervised' | 'autonomous'
export type AgentsDocumentationTask = 'scaffold' | 'update-raz'

export interface QuickTaskPreset {
  role:     RoleId
  workflow: string
  desc:     string
}

const DOCUMENTATION_ONLY_NOTE =
  'This is documentation-only work. If no application logic changes, do not create a QA handoff.'

const TASKS: Record<AgentsDocumentationTask, { survey: string; write: string }> = {
  scaffold: {
    survey:
      'Survey package.json, the lockfile, README, config files, and project structure to determine the actual stack and conventions.',
    write:
      'Create or update AGENTS.md documenting the verified framework and version, key commands (dev, build, test, lint), database and migration conventions, required environment variables, and critical rules an AI agent must follow in this codebase.',
  },
  'update-raz': {
    survey:
      'Survey Raziel, especially lib/, app/api/, package.json, configuration, and existing agent documentation, to determine its actual capabilities and conventions.',
    write:
      'Create or update AGENTS.md documenting Raziel’s verified tech stack, available MCP tools and their purposes, key environment variables, operating modes, and critical rules agents must follow.',
  },
}

export function getAgentsDocumentationPreset(
  mode: RazMode,
  task: AgentsDocumentationTask,
): QuickTaskPreset {
  const instructions = TASKS[task]

  if (mode === 'standard') {
    return {
      role:        'RAZ-Dev',
      workflow:    'feature',
      desc:        `${instructions.survey} Then ${instructions.write} ${DOCUMENTATION_ONLY_NOTE}`,
    }
  }

  return {
    role:     'RAZ-Ops',
    workflow: 'strategy',
    desc:
      `${instructions.survey} Do not edit files. Generate a concise report, then hand off to RAZ-Dev with workflow=feature and the instruction: "${instructions.write}" Complete your Ops task after creating the handoff.`,
  }
}
