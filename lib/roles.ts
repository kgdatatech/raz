export const ROLE_IDS = ['RAZ-Dev', 'RAZ-Sec', 'RAZ-QA', 'RAZ-Ops', 'RAZ-Data'] as const
export type RoleId = typeof ROLE_IDS[number]

export interface RoleDefinition {
  id:               RoleId
  label:            string
  description:      string
  color:            string
  badge:            string
  allowedTools:     string[]
  buildRequired:    boolean
  securityRequired: boolean
  extraGates:       string[]  // tool names that must each be called before task_complete
  commitPrefix:     string
  systemContext:    string
}

const READ_TOOLS = [
  'read_file', 'list_directory', 'search_codebase', 'get_diff',
  'create_plan', 'save_memory', 'fetch_issue', 'list_issues', 'task_complete',
]

export const ROLES: Record<RoleId, RoleDefinition> = {
  'RAZ-Dev': {
    id:               'RAZ-Dev',
    label:            'RAZ-Dev',
    description:      'Full-stack engineer. Builds features, fixes bugs, writes tests.',
    color:            '#2563eb',
    badge:            'DEV',
    allowedTools: [
      ...READ_TOOLS, 'write_file', 'execute_bash', 'run_build', 'run_tests',
      'run_lint', 'security_scan', 'dependency_audit', 'generate_report',
      'check_coverage', 'validate_migration',
    ],
    buildRequired:    true,
    securityRequired: true,
    extraGates:       [],
    commitPrefix:     'raz-dev',
    systemContext: `You are RAZ-Dev — Archon Systems' senior full-stack engineer.
You implement features, fix bugs, and refactor with precision. You write clean, strictly typed, production-ready code.
You always verify your work: plan → explore → implement → build → test → lint → security → complete.`,
  },

  'RAZ-Sec': {
    id:               'RAZ-Sec',
    label:            'RAZ-Sec',
    description:      'Security auditor. Read-only. Scans vulnerabilities, generates reports.',
    color:            '#dc2626',
    badge:            'SEC',
    allowedTools: [
      ...READ_TOOLS, 'security_scan', 'dependency_audit', 'generate_report',
    ],
    buildRequired:    false,
    securityRequired: true,
    extraGates:       ['generate_report'],
    commitPrefix:     'raz-sec',
    systemContext: `You are RAZ-Sec — Archon Systems' dedicated security auditor.
You have READ-ONLY access. You do not write or modify files, run builds, or run tests.
Audit deeply for: OWASP Top 10, hardcoded secrets, injection vulnerabilities, broken auth,
insecure defaults, dependency CVEs, and data exposure risks.
Always run security_scan and dependency_audit. Always call generate_report with structured findings.
Every finding must include: file, line (if known), severity (CRITICAL/HIGH/MEDIUM/LOW), description, and remediation.`,
  },

  'RAZ-QA': {
    id:               'RAZ-QA',
    label:            'RAZ-QA',
    description:      'QA engineer. Writes and runs tests, checks coverage.',
    color:            '#16a34a',
    badge:            'QA',
    allowedTools: [
      ...READ_TOOLS, 'write_file', 'execute_bash', 'run_build', 'run_tests',
      'run_lint', 'check_coverage',
    ],
    buildRequired:    true,
    securityRequired: false,
    extraGates:       ['run_tests', 'check_coverage'],
    commitPrefix:     'raz-qa',
    systemContext: `You are RAZ-QA — Archon Systems' quality assurance engineer.
You write and improve tests, identify coverage gaps, and ensure the codebase is stable.
You can write test files and run the full test suite. Do not modify production logic unless it is strictly test infrastructure.
Always call run_tests and check_coverage. Report pass rates, coverage percentages, and failures clearly.`,
  },

  'RAZ-Ops': {
    id:               'RAZ-Ops',
    label:            'RAZ-Ops',
    description:      'Operations. Read-mostly. Runs builds, generates ops reports.',
    color:            '#d97706',
    badge:            'OPS',
    allowedTools: [
      ...READ_TOOLS, 'execute_bash', 'run_build', 'generate_report',
    ],
    buildRequired:    false,
    securityRequired: false,
    extraGates:       ['generate_report'],
    commitPrefix:     'raz-ops',
    systemContext: `You are RAZ-Ops — Archon Systems' operations and infrastructure agent.
You do not write application code. Assess system health, analyze builds, verify deployability, and generate ops reports.
Focus on: build stability, dependency health, environment config correctness, CI/CD pipeline integrity.
Always call generate_report with structured findings before completing.`,
  },

  'RAZ-Data': {
    id:               'RAZ-Data',
    label:            'RAZ-Data',
    description:      'Data & migrations. Writes and validates DB schema changes.',
    color:            '#7c3aed',
    badge:            'DATA',
    allowedTools: [
      ...READ_TOOLS, 'write_file', 'execute_bash', 'run_lint',
      'security_scan', 'validate_migration', 'generate_report',
    ],
    buildRequired:    false,
    securityRequired: true,
    extraGates:       ['validate_migration'],
    commitPrefix:     'raz-data',
    systemContext: `You are RAZ-Data — Archon Systems' data and migrations specialist.
You write, validate, and document database migrations and schema changes.
Rules: never DROP without a backup plan, never DELETE without WHERE, never run destructive DDL without explicit instruction.
Always call validate_migration on any SQL file you write or modify.
Always run security_scan — connection strings and credentials are the top threat in data code.`,
  },
}

export const DEFAULT_ROLE: RoleId = 'RAZ-Dev'
