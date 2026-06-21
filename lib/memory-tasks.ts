import { randomUUID } from 'crypto'
import {
  listMemoryRows, createQueuedTask, hasRecentCompletion,
  PRIORITY, type RepoRow, type PriorityLevel,
} from './db'
import { type RoleId } from './roles'

// ── Rule table ────────────────────────────────────────────────────────────────
// Each rule matches on the memory key prefix (the segment before the first ':').
// Rules are checked in order — first match wins.

export interface MemoryTaskRule {
  keyPattern: RegExp
  role:       RoleId
  workflow:   string
  priority:   PriorityLevel
  label:      string
}

export const MEMORY_TASK_RULES: MemoryTaskRule[] = [
  {
    keyPattern: /^(security|vuln|cve|secret|exposed)/i,
    role:       'RAZ-Sec',
    workflow:   'audit',
    priority:   PRIORITY.CRITICAL,
    label:      'Security finding',
  },
  {
    keyPattern: /^(bug|error|broken|crash|regression|fail)/i,
    role:       'RAZ-Dev',
    workflow:   'fix',
    priority:   PRIORITY.HIGH,
    label:      'Bug finding',
  },
  {
    keyPattern: /^(deps|dependency|outdated|upgrade|package)/i,
    role:       'RAZ-Ops',
    workflow:   'strategy',
    priority:   PRIORITY.NORMAL,
    label:      'Dependency finding',
  },
  {
    keyPattern: /^(test|coverage|spec)/i,
    role:       'RAZ-QA',
    workflow:   'test',
    priority:   PRIORITY.NORMAL,
    label:      'Test coverage finding',
  },
  {
    keyPattern: /^(todo|missing|needed|improve|perf|performance|slow)/i,
    role:       'RAZ-Dev',
    workflow:   'feature',
    priority:   PRIORITY.NORMAL,
    label:      'Improvement finding',
  },
  {
    keyPattern: /^(data|schema|migration|db)/i,
    role:       'RAZ-Data',
    workflow:   'feature',
    priority:   PRIORITY.NORMAL,
    label:      'Data finding',
  },
]

// ── Classifier ────────────────────────────────────────────────────────────────

export function classifyMemoryEntry(key: string, _value: string): MemoryTaskRule | null {
  const prefix = key.split(':')[0] ?? key
  return MEMORY_TASK_RULES.find((r) => r.keyPattern.test(prefix)) ?? null
}

// ── Task description ──────────────────────────────────────────────────────────

export function descriptionForMemoryEntry(key: string, value: string, label: string): string {
  const truncatedValue = value.slice(0, 120)
  return `${label}: ${key} — ${truncatedValue}`
}

export function branchForMemoryEntry(key: string): string {
  const slug = key
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/-$/, '')
  return `razdev/memory-${slug}`
}

// ── Main seeder ───────────────────────────────────────────────────────────────

export interface MemoryTaskResult {
  queued:   number
  skipped:  number
  findings: Array<{ key: string; status: 'queued' | 'skipped' | 'unclassified' }>
}

export async function seedMemoryTasks(repo: RepoRow): Promise<MemoryTaskResult> {
  const rows   = listMemoryRows(repo.id)
  const result: MemoryTaskResult = { queued: 0, skipped: 0, findings: [] }

  for (const row of rows) {
    const rule = classifyMemoryEntry(row.key, row.value)
    if (!rule) {
      result.findings.push({ key: row.key, status: 'unclassified' })
      continue
    }

    const description = descriptionForMemoryEntry(row.key, row.value, rule.label)

    if (hasRecentCompletion(repo.id, description)) {
      result.skipped++
      result.findings.push({ key: row.key, status: 'skipped' })
      continue
    }

    const branch = branchForMemoryEntry(row.key)
    createQueuedTask(
      randomUUID(),
      repo.id,
      description,
      branch,
      rule.workflow,
      rule.role,
      undefined,
      'queued',
      rule.priority,
    )

    result.queued++
    result.findings.push({ key: row.key, status: 'queued' })
  }

  return result
}
