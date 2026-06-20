'use client'

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { ROLES, ROLE_IDS, type RoleId, DEFAULT_ROLE } from '@/lib/roles'
import BrainView from './components/BrainView'
import { detectIntent, type DispatchResult } from '@/lib/dispatch'

interface RepoRow {
  id:             number
  github_owner:   string
  github_repo:    string
  local_path:     string | null
  default_branch: string
}

interface IssueRow {
  id:        number
  number:    number
  title:     string
  body:      string | null
  state:     string
  labels:    string | null
  assignee:  string | null
  synced_at: string
}

interface PrStatusRow {
  id:              number
  task_id:         string
  pr_number:       number | null
  state:           string | null
  ci_status:       string | null
  review_decision: string | null
  merged:          number
  checked_at:      string
}

interface PRDetails {
  number:         number
  title:          string
  body:           string | null
  state:          string
  merged:         boolean
  mergeableState: string | null
  headBranch:     string
  baseBranch:     string
  author:         string
  createdAt:      string
  files:          { filename: string; additions: number; deletions: number; status: string }[]
  comments:       { author: string; body: string; createdAt: string }[]
  ciStatus:       string
  approvals:      number
}

interface TaskRow {
  id:             string
  description:    string
  branch:         string
  status:         string
  workflow:       string
  role:           string | null
  issue_number:   number | null
  plan:           string | null
  pr_url:         string | null
  summary:        string | null
  error:          string | null
  files_changed:  string | null
  parent_task_id: string | null
  created_at:     string
}

interface MemoryRow {
  id:         number
  repo_id:    number
  key:        string
  value:      string
  updated_at: string
}

interface AgentMessageRow {
  id:           number
  from_role:    string
  to_role:      string
  from_task_id: string | null
  to_task_id:   string | null
  message_type: string
  message:      string
  context:      string | null
  result:       string | null
  created_at:   string
}

interface QueueItem {
  id:            string
  description:   string
  role:          RoleId
  workflow:      string
  issueNumber?:  number
  resumeTaskId?: string
}

interface HandoffSuggestion {
  taskId:      string
  role:        RoleId
  description: string
  workflow:    string
  branch:      string
  fromRole:    string
}

interface LogEntry {
  type:    'thinking' | 'tool_call' | 'tool_result' | 'plan' | 'usage' | 'complete' | 'error' | 'delegation' | 'handoff' | 'ask_user'
  message: string
  data?:   Record<string, unknown>
  ts:      number
}

const CC_MODE = process.env.NEXT_PUBLIC_RAZ_RUNNER === 'cc'

const WORKFLOWS = [
  { value: 'feature',  label: 'Feature'  },
  { value: 'fix',      label: 'Fix'      },
  { value: 'refactor', label: 'Refactor' },
  { value: 'audit',    label: 'Audit'    },
  { value: 'test',     label: 'Test'     },
  { value: 'strategy', label: 'Strategy' },
]

const ROLE_COLORS_CSS: Record<string, string> = {
  'RAZ-Dev':  '#6366f1',
  'RAZ-Sec':  '#ef4444',
  'RAZ-QA':   '#22c55e',
  'RAZ-Ops':  '#a855f7',
  'RAZ-Data': '#f59e0b',
}

const ROLE_DEFAULT_WORKFLOW: Record<RoleId, string> = {
  'RAZ-Dev':  'feature',
  'RAZ-Sec':  'audit',
  'RAZ-QA':   'test',
  'RAZ-Ops':  'strategy',
  'RAZ-Data': 'feature',
}

const ROLE_WORKFLOWS: Record<RoleId, string[]> = {
  'RAZ-Dev':  ['feature', 'fix', 'refactor', 'test', 'strategy', 'self'],
  'RAZ-Sec':  ['audit', 'strategy'],
  'RAZ-QA':   ['test', 'fix'],
  'RAZ-Ops':  ['audit', 'strategy', 'self'],
  'RAZ-Data': ['feature', 'fix', 'refactor'],
}

const TYPE_STYLES: Record<LogEntry['type'], string> = {
  thinking:    'text-gray-500',
  tool_call:   'text-blue-600',
  tool_result: 'text-gray-400',
  plan:        'text-indigo-600',
  usage:       'text-gray-300',
  complete:    'text-green-600',
  error:       'text-red-500',
  delegation:  'text-violet-600',
  handoff:     'text-amber-600',
  ask_user:    'text-orange-600',
}

const TYPE_PREFIX: Record<LogEntry['type'], string> = {
  thinking:    '·',
  tool_call:   '▶',
  tool_result: '  ↳',
  plan:        '⊞',
  usage:       '$',
  complete:    '✓',
  error:       '✗',
  delegation:  '⇒',
  handoff:     '⟶',
  ask_user:    '?',
}

const STATUS_DOT: Record<string, string> = {
  complete: 'bg-green-500',
  failed:   'bg-red-500',
  running:  'bg-yellow-400 animate-pulse',
  queued:   'bg-violet-400',
}

const STATUS_TEXT: Record<string, string> = {
  complete: 'text-green-700',
  failed:   'text-red-600',
  running:  'text-yellow-600',
  queued:   'text-violet-600',
}

const MSG_TYPE_COLORS: Record<string, string> = {
  delegation: 'text-violet-600 bg-violet-50 border-violet-200',
  handoff:    'text-amber-600 bg-amber-50 border-amber-200',
}

function inlineRender(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`'))
      return <code key={i} className="font-mono bg-gray-100 px-0.5 rounded text-[9px]">{part.slice(1, -1)}</code>
    return part
  })
}

function parseTableRow(line: string): string[] {
  return line.split('|').slice(1, -1).map((c) => c.trim())
}

function isTableSeparator(line: string): boolean {
  return /^\|[\s|:-]+\|$/.test(line.trim())
}

function Markdown({ text, className = '', report = false }: { text: string; className?: string; report?: boolean }) {
  const lines = text.split('\n')
  const elements: React.ReactNode[] = []
  let listItems:  string[]    = []
  let tableLines: string[]    = []
  let inCode     = false
  let codeLines: string[]     = []
  let key = 0

  const bodyText  = report ? 'text-sm' : 'text-xs'
  const bodyColor = 'text-gray-700'

  function flushList() {
    if (!listItems.length) return
    elements.push(
      <ul key={key++} className="list-disc list-inside space-y-0.5 my-1.5 pl-1">
        {listItems.map((li, i) => <li key={i} className={`${bodyText} ${bodyColor} leading-relaxed`}>{inlineRender(li)}</li>)}
      </ul>
    )
    listItems = []
  }

  function flushTable() {
    if (!tableLines.length) return
    const rows = tableLines.filter((l) => !isTableSeparator(l)).map(parseTableRow)
    if (rows.length === 0) { tableLines = []; return }
    const headers  = rows[0]
    const dataRows = rows.slice(1)
    elements.push(
      <div key={key++} className="overflow-x-auto my-3 rounded-lg border border-gray-200">
        <table className="w-full text-xs border-collapse">
          <thead className="bg-gray-50">
            <tr>
              {headers.map((h, i) => (
                <th key={i} className="px-3 py-2 text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-200 whitespace-nowrap">
                  {inlineRender(h)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {dataRows.map((row, ri) => (
              <tr key={ri} className="hover:bg-gray-50 transition-colors">
                {row.map((cell, ci) => (
                  <td key={ci} className={`px-3 py-2 ${bodyText} ${bodyColor} leading-relaxed align-top`}>
                    {inlineRender(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
    tableLines = []
  }

  function flushCode() {
    if (!codeLines.length) return
    elements.push(
      <pre key={key++} className="my-2 overflow-x-auto rounded-lg bg-gray-900 text-gray-100 px-4 py-3 text-[10px] font-mono leading-relaxed">
        <code>{codeLines.join('\n')}</code>
      </pre>
    )
    codeLines = []
  }

  for (const line of lines) {
    // Code fence
    if (line.startsWith('```')) {
      if (!inCode) { flushList(); flushTable(); inCode = true }
      else         { inCode = false; flushCode() }
      continue
    }
    if (inCode) { codeLines.push(line); continue }

    // Table rows
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      flushList()
      tableLines.push(line)
      continue
    } else {
      flushTable()
    }

    // Horizontal rule
    if (/^[-*_]{3,}$/.test(line.trim())) {
      flushList()
      elements.push(<hr key={key++} className="border-gray-200 my-4" />)
      continue
    }

    if (/^#### /.test(line))      { flushList(); elements.push(<h4 key={key++} className={`text-xs font-bold text-gray-700 mt-2 mb-0.5`}>{inlineRender(line.slice(5))}</h4>) }
    else if (/^### /.test(line))  { flushList(); elements.push(<h3 key={key++} className={`${report ? 'text-sm' : 'text-xs'} font-bold text-gray-800 mt-4 mb-1`}>{inlineRender(line.slice(4))}</h3>) }
    else if (/^## /.test(line))   { flushList(); elements.push(<h2 key={key++} className={`${report ? 'text-base' : 'text-sm'} font-bold text-gray-900 mt-5 mb-1.5`}>{inlineRender(line.slice(3))}</h2>) }
    else if (/^# /.test(line))    { flushList(); elements.push(<h1 key={key++} className={`${report ? 'text-xl' : 'text-base'} font-bold text-gray-900 mt-4 mb-2`}>{inlineRender(line.slice(2))}</h1>) }
    else if (/^[-*] /.test(line)) { listItems.push(line.slice(2)) }
    else if (/^\d+\. /.test(line)){ listItems.push(line.replace(/^\d+\. /, '')) }
    else if (line.trim() === '')  { flushList(); elements.push(<div key={key++} className="h-2" />) }
    else                          { flushList(); elements.push(<p key={key++} className={`${bodyText} ${bodyColor} leading-relaxed`}>{inlineRender(line)}</p>) }
  }
  flushList(); flushTable(); flushCode()
  return <div className={className}>{elements}</div>
}

function MemoryEntry({
  row, onDelete, onSave,
}: {
  row: MemoryRow; onDelete: (key: string) => void; onSave: (key: string, value: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState(row.value)

  function commit() {
    if (draft.trim() && draft !== row.value) onSave(row.key, draft.trim())
    setEditing(false)
  }

  return (
    <div className="flex items-start gap-2 px-4 py-2.5 border-b border-gray-100 group hover:bg-gray-50">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[9px] font-semibold text-indigo-600 uppercase tracking-wide truncate">{row.key}</span>
          <span className="text-[8px] text-gray-300 ml-auto flex-shrink-0">
            {new Date(row.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </span>
        </div>
        {editing ? (
          <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit() } }}
            rows={2} className="w-full text-[10px] text-gray-700 bg-white border border-indigo-300 rounded px-1.5 py-1 resize-none focus:outline-none focus:ring-1 focus:ring-indigo-400" />
        ) : (
          <p onClick={() => setEditing(true)} className="text-[10px] text-gray-600 leading-relaxed cursor-text line-clamp-2" title="Click to edit">{row.value}</p>
        )}
      </div>
      <button onClick={() => onDelete(row.key)} className="text-[10px] text-gray-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0 mt-0.5">✕</button>
    </div>
  )
}

export default function RazDashboard() {
  const [owner,           setOwner]           = useState('')
  const [repos,           setRepos]           = useState<RepoRow[]>([])
  const [selectedRepo,    setSelectedRepo]    = useState<RepoRow | null>(null)
  const [localPath,       setLocalPath]       = useState('')
  const [role,            setRole]            = useState<RoleId>(DEFAULT_ROLE)
  const [workflow,        setWorkflow]        = useState('feature')
  const [issues,          setIssues]          = useState<IssueRow[]>([])
  const [selectedIssue,   setSelectedIssue]   = useState<IssueRow | null>(null)
  const [syncingIssues,   setSyncingIssues]   = useState(false)
  const [task,            setTask]            = useState('')
  const [running,         setRunning]         = useState(false)
  const [log,             setLog]             = useState<LogEntry[]>([])
  const [prUrl,           setPrUrl]           = useState<string | null>(null)
  const [tasks,           setTasks]           = useState<TaskRow[]>([])
  const [loadingRepos,    setLoadingRepos]    = useState(true)
  const [activePlan,      setActivePlan]      = useState<string | null>(null)
  const [elapsed,         setElapsed]         = useState(0)
  const [liveCost,           setLiveCost]           = useState<number>(0)
  const [finalCost,          setFinalCost]          = useState<number | null>(null)
  const [rateLimitResetAt,   setRateLimitResetAt]   = useState<Date | null>(null)
  const [rateLimitSecondsLeft, setRateLimitSecondsLeft] = useState(0)
  const [selectedTask,    setSelectedTask]    = useState<TaskRow | null>(null)
  const [planOpen,        setPlanOpen]        = useState(false)
  const [bottomTab,       setBottomTab]       = useState<'history' | 'memory' | 'comms' | 'issues' | 'reports' | 'brain'>('history')
  const [memory,          setMemory]          = useState<MemoryRow[]>([])
  const [messages,        setMessages]        = useState<AgentMessageRow[]>([])
  const [allIssues,       setAllIssues]       = useState<IssueRow[]>([])
  const [issueFilter,     setIssueFilter]     = useState<'open' | 'closed'>('open')
  const [prStatus,        setPrStatus]        = useState<PrStatusRow | null>(null)
  const [prDetails,       setPrDetails]       = useState<PRDetails | null>(null)
  const [prDetailsLoading, setPrDetailsLoading] = useState(false)
  const [prActionLoading, setPrActionLoading] = useState<string | null>(null)
  const [reports,         setReports]         = useState<{ file: string; size: number; mtime: string }[]>([])
  const [openReport,      setOpenReport]      = useState<{ file: string; content: string } | null>(null)
  const [queue,           setQueue]           = useState<QueueItem[]>([])
  const [handoffSuggestions, setHandoffSuggestions] = useState<HandoffSuggestion[]>([])
  const [historyFilter,      setHistoryFilter]      = useState('')
  const [answeredQuestions,  setAnsweredQuestions]  = useState<Map<string, string>>(new Map())
  const [questionInputs,     setQuestionInputs]     = useState<Record<string, string>>({})
  const [pendingQuestionId,  setPendingQuestionId]  = useState<string | null>(null)
  const [razMode,            setRazMode]            = useState<'standard' | 'supervised' | 'autonomous'>('standard')
  const [isPaused,           setIsPaused]           = useState(false)
  const [showOptions,        setShowOptions]        = useState(false)
  const [showQuickTasks,     setShowQuickTasks]     = useState(false)
  const [dispatch,           setDispatch]           = useState<DispatchResult | null>(null)
  const [dispatchCountdown,  setDispatchCountdown]  = useState<number | null>(null)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const debounceRef  = useRef<ReturnType<typeof setTimeout>  | null>(null)

  const logRef         = useRef<HTMLDivElement>(null)
  const abortRef       = useRef<AbortController | null>(null)
  const startRef       = useRef<number>(0)
  const timerRef       = useRef<ReturnType<typeof setInterval> | null>(null)
  const queueRef       = useRef<QueueItem[]>([])
  const panelResizeRef = useRef<{ startY: number; startH: number } | null>(null)
  const [panelH,       setPanelH]       = useState(224)

  useEffect(() => { queueRef.current = queue }, [queue])

  useEffect(() => {
    fetch('/api/repos')
      .then((r) => r.json())
      .then(({ owner: o, repos: r }) => { setOwner(o ?? ''); setRepos(r ?? []) })
      .catch(() => {})
      .finally(() => setLoadingRepos(false))
    fetch('/api/config')
      .then((r) => r.json())
      .then((cfg) => {
        if (cfg.raz_mode) setRazMode(cfg.raz_mode as 'standard' | 'supervised' | 'autonomous')
        if (cfg.task_paused) setIsPaused(cfg.task_paused === '1')
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!selectedRepo) return
    setLocalPath(selectedRepo.local_path ?? '')
    setSelectedIssue(null)
    setIssues([])
    setAllIssues([])
    setMemory([])
    setMessages([])
    setPrStatus(null)
    setPrDetails(null)
    loadTasks(selectedRepo.id)
    loadMemory(selectedRepo.id)
    loadMessages(selectedRepo.id)
    loadAllIssues(selectedRepo.id, 'open')
    loadReports()
  }, [selectedRepo])

  useEffect(() => {
    if (workflow === 'fix' && selectedRepo && issues.length === 0) loadIssues(selectedRepo)
  }, [workflow, selectedRepo])

  useEffect(() => {
    if (!rateLimitResetAt) return
    const tick = setInterval(() => {
      const left = Math.max(0, Math.floor((rateLimitResetAt.getTime() - Date.now()) / 1000))
      setRateLimitSecondsLeft(left)
      if (left === 0) { setRateLimitResetAt(null); clearInterval(tick) }
    }, 1000)
    return () => clearInterval(tick)
  }, [rateLimitResetAt])

  function loadTasks(repoId: number) {
    fetch(`/api/tasks?repoId=${repoId}`).then((r) => r.json()).then(setTasks).catch(() => {})
  }

  function loadMemory(repoId: number) {
    fetch(`/api/memory?repoId=${repoId}`).then((r) => r.json()).then(setMemory).catch(() => {})
  }

  function loadMessages(repoId: number) {
    fetch(`/api/messages?repoId=${repoId}`).then((r) => r.json()).then(setMessages).catch(() => {})
  }

  function loadAllIssues(repoId: number, state: 'open' | 'closed') {
    fetch(`/api/issues?repoId=${repoId}&state=${state}`).then((r) => r.json()).then(setAllIssues).catch(() => {})
  }

  async function loadPrStatus(taskId: string) {
    const data = await fetch(`/api/pr-status?taskId=${taskId}`).then((r) => r.json()).catch(() => null)
    setPrStatus(data)
  }

  function parsePRUrl(url: string): { owner: string; repo: string; prNumber: number } | null {
    const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
    if (!m) return null
    return { owner: m[1], repo: m[2], prNumber: Number(m[3]) }
  }

  async function loadPRDetails(prUrl: string) {
    const parsed = parsePRUrl(prUrl)
    if (!parsed) return
    setPrDetailsLoading(true)
    setPrDetails(null)
    const data = await fetch(`/api/pr/details?owner=${parsed.owner}&repo=${parsed.repo}&prNumber=${parsed.prNumber}`)
      .then((r) => r.json()).catch(() => null)
    setPrDetails(data?.error ? null : data)
    setPrDetailsLoading(false)
  }

  async function handlePRAction(action: 'merge' | 'close' | 'reopen', prUrl: string) {
    const parsed = parsePRUrl(prUrl)
    if (!parsed) return
    setPrActionLoading(action)
    await fetch('/api/pr/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...parsed }),
    }).catch(() => {})
    setPrActionLoading(null)
    await loadPRDetails(prUrl)
  }

  function loadReports() {
    fetch('/api/reports').then((r) => r.json()).then(setReports).catch(() => {})
  }

  async function openReportFile(file: string) {
    const data = await fetch(`/api/reports?file=${encodeURIComponent(file)}`).then((r) => r.json()).catch(() => null)
    if (data?.content) setOpenReport({ file, content: data.content })
  }

  async function handleDeleteMemory(key: string) {
    if (!selectedRepo) return
    await fetch('/api/memory', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repoId: selectedRepo.id, key }) })
    setMemory((prev) => prev.filter((m) => m.key !== key))
  }

  async function handleSaveMemory(key: string, value: string) {
    if (!selectedRepo) return
    await fetch('/api/memory', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repoId: selectedRepo.id, key, value }) })
    setMemory((prev) => prev.map((m) => m.key === key ? { ...m, value, updated_at: new Date().toISOString() } : m))
  }

  async function loadIssues(repo: RepoRow) {
    const cached = await fetch(`/api/issues?repoId=${repo.id}`).then((r) => r.json()).catch(() => [])
    if (cached.length > 0) { setIssues(cached); return }
    syncIssues(repo)
  }

  async function syncIssues(repo: RepoRow) {
    setSyncingIssues(true)
    try {
      const res = await fetch('/api/issues', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: repo.github_owner, repo: repo.github_repo }) })
      const { issues: synced } = await res.json()
      setIssues(synced ?? [])
    } catch {}
    setSyncingIssues(false)
  }

  function appendLog(entry: Omit<LogEntry, 'ts'>) {
    setLog((prev) => [...prev, { ...entry, ts: Date.now() }])
    if (entry.type === 'plan') { setActivePlan(entry.message); setPlanOpen(true) }
    if (entry.type === 'ask_user' && entry.data?.questionId) {
      setPendingQuestionId(entry.data.questionId as string)
    }
    if (CC_MODE) {
      if (entry.type === 'error' && entry.data?.rateLimited) {
        const resetAt = entry.data.resetAt as string | undefined
        setRateLimitResetAt(resetAt ? new Date(resetAt) : new Date(Date.now() + 3_600_000))
      }
    } else {
      if (entry.type === 'usage')    setLiveCost((entry.data?.costUsd as number) ?? 0)
      if (entry.type === 'complete') setFinalCost((entry.data?.costUsd as number) ?? liveCost)
      if (entry.type === 'error')    setFinalCost((prev) => prev ?? liveCost)
    }
    setTimeout(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }), 50)
  }

  async function saveLocalPath() {
    if (!selectedRepo || !localPath) return
    await fetch('/api/repos', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: selectedRepo.github_owner, repo: selectedRepo.github_repo, localPath }) })
    const updated = { ...selectedRepo, local_path: localPath }
    setRepos((prev) => prev.map((r) => r.id === selectedRepo.id ? updated : r))
    setSelectedRepo(updated)
  }

  async function runTask(params: { description: string; role: RoleId; workflow: string; issueNumber?: number; resumeTaskId?: string }) {
    if (!selectedRepo) return
    if (!selectedRepo.local_path && !localPath.trim()) { alert('Set the local repo path first.'); return }
    if (localPath && localPath !== selectedRepo.local_path) await saveLocalPath()

    const abort = new AbortController()
    abortRef.current = abort
    startRef.current = Date.now()
    setElapsed(0)
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000)

    setRunning(true)
    setLog([])
    setPrUrl(null)
    setActivePlan(null)
    setPlanOpen(false)
    setLiveCost(0)
    setFinalCost(null)
    setDispatch(null)
    cancelCountdown()

    try {
      const res = await fetch('/api/agent', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: abort.signal,
        body: JSON.stringify({
          owner: selectedRepo.github_owner, repo: selectedRepo.github_repo,
          description: params.description, workflow: params.workflow,
          role: params.role, issueNumber: params.issueNumber, resumeTaskId: params.resumeTaskId,
        }),
      })

      if (!res.ok || !res.body) { appendLog({ type: 'error', message: 'Failed to start agent.' }); return }

      // Task was created server-side — refresh history immediately so the running card appears
      if (selectedRepo) loadTasks(selectedRepo.id)

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let   buffer  = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const event = JSON.parse(line.slice(6))
            appendLog(event)
            if (event.type === 'complete' && event.data?.prUrl) setPrUrl(event.data.prUrl as string)
            // Handoff: auto-accept in supervised/autonomous, show suggestion in standard
            if (event.type === 'handoff' && event.data?.taskId) {
              const d = event.data
              const suggestion = {
                taskId:      d.taskId as string,
                role:        d.role as RoleId,
                description: d.description as string,
                workflow:    (d.workflow as string) ?? ROLE_DEFAULT_WORKFLOW[d.role as RoleId],
                branch:      (d.branch as string) ?? '',
                fromRole:    params.role,
              }
              if (razMode === 'supervised' || razMode === 'autonomous') {
                setTimeout(() => acceptHandoff(suggestion), 800)
              } else {
                setHandoffSuggestions((prev) => [...prev, suggestion])
              }
            }
          } catch {}
        }
      }

      if (selectedRepo) {
        loadTasks(selectedRepo.id)
        if (bottomTab === 'comms') loadMessages(selectedRepo.id)
      }
      loadReports()
    } catch (e) {
      appendLog({ type: 'error', message: `Connection error: ${e}` })
    } finally {
      if (timerRef.current) clearInterval(timerRef.current)
      setRunning(false)
      if (isPaused) handleResume()
      const next = queueRef.current[0]
      if (next) {
        setQueue((prev) => prev.slice(1))
        queueRef.current = queueRef.current.slice(1)
        setRole(next.role)
        setWorkflow(next.workflow)
        setTimeout(() => runTask(next), 400)
      }
    }
  }

  function handleRun() {
    if (!selectedRepo || !task.trim()) return
    cancelCountdown()
    const effectiveRole     = dispatch?.role     ?? role
    const effectiveWorkflow = dispatch?.workflow ?? workflow
    runTask({ description: task, role: effectiveRole, workflow: effectiveWorkflow, issueNumber: selectedIssue?.number })
  }

  function addToQueue() {
    if (!task.trim()) return
    setQueue((prev) => [...prev, { id: Math.random().toString(36).slice(2), description: task, role, workflow, issueNumber: selectedIssue?.number }])
    setTask('')
  }

  function acceptHandoff(s: HandoffSuggestion) {
    setHandoffSuggestions((prev) => prev.filter((h) => h.taskId !== s.taskId))
    if (running) {
      setQueue((prev) => [...prev, { id: s.taskId, description: s.description, role: s.role, workflow: s.workflow, resumeTaskId: s.taskId }])
    } else {
      setRole(s.role)
      setWorkflow(s.workflow)
      runTask({ description: s.description, role: s.role, workflow: s.workflow, resumeTaskId: s.taskId })
    }
  }

  function dismissHandoff(taskId: string) {
    setHandoffSuggestions((prev) => prev.filter((h) => h.taskId !== taskId))
  }

  const cancelCountdown = useCallback(() => {
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null }
    if (debounceRef.current)  { clearTimeout(debounceRef.current);   debounceRef.current  = null }
    setDispatchCountdown(null)
  }, [])

  function startCountdown(value: string, result: DispatchResult) {
    setRole(result.role)
    setWorkflow(result.workflow)
    let secs = 5
    setDispatchCountdown(secs)
    countdownRef.current = setInterval(() => {
      secs -= 1
      if (secs <= 0) {
        cancelCountdown()
        runTask({ description: value, role: result.role, workflow: result.workflow })
      } else {
        setDispatchCountdown(secs)
      }
    }, 1000)
  }

  function handleTaskInput(value: string) {
    setTask(value)
    // Cancel any in-flight countdown or pending debounce on every keystroke
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; setDispatchCountdown(null) }
    if (debounceRef.current)  { clearTimeout(debounceRef.current);   debounceRef.current  = null }

    if (!value.trim() || value.trim().length < 8) { setDispatch(null); return }

    // Dispatch chip updates live so user sees the detected role while typing
    const result = detectIntent(value)
    setDispatch(result)

    if (razMode === 'standard') {
      setRole(result.role)
      setWorkflow(result.workflow)
      return
    }

    // Supervised / Autonomous: wait 1.5 s after the user stops typing, then start the 5 s countdown
    if ((razMode === 'supervised' || razMode === 'autonomous') && !running && selectedRepo && (selectedRepo.local_path || localPath.trim())) {
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
        startCountdown(value, result)
      }, 1500)
    }
  }

  async function changeMode(mode: 'standard' | 'supervised' | 'autonomous') {
    setRazMode(mode)
    await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'raz_mode', value: mode }) }).catch(() => {})
  }

  async function handlePause() {
    setIsPaused(true)
    await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'task_paused', value: '1' }) }).catch(() => {})
  }

  async function handleResume() {
    setIsPaused(false)
    await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'task_paused', value: '0' }) }).catch(() => {})
  }

  function startPanelResize(e: React.MouseEvent) {
    panelResizeRef.current = { startY: e.clientY, startH: panelH }
    const onMove = (ev: MouseEvent) => {
      if (!panelResizeRef.current) return
      const delta = panelResizeRef.current.startY - ev.clientY
      setPanelH(Math.max(150, Math.min(640, panelResizeRef.current.startH + delta)))
    }
    const onUp = () => {
      panelResizeRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  async function submitAnswer(questionId: string, answer: string) {
    if (!answer.trim()) return
    await fetch('/api/agent/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId, answer: answer.trim() }),
    }).catch(() => {})
    setAnsweredQuestions((prev) => new Map(prev).set(questionId, answer.trim()))
    setQuestionInputs((prev) => { const next = { ...prev }; delete next[questionId]; return next })
    if (pendingQuestionId === questionId) setPendingQuestionId(null)
  }

  async function handleDeleteTask(id: string) {
    await fetch('/api/tasks', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    setTasks((prev) => prev.filter((t) => t.id !== id))
    if (selectedTask?.id === id) setSelectedTask(null)
  }

  function handleRetry(t: TaskRow) {
    const retryRole     = (ROLE_IDS.includes(t.role as RoleId) ? t.role : DEFAULT_ROLE) as RoleId
    const retryWorkflow = ROLE_WORKFLOWS[retryRole].includes(t.workflow ?? '') ? t.workflow : ROLE_DEFAULT_WORKFLOW[retryRole]
    setSelectedTask(null)
    setRole(retryRole)
    setWorkflow(retryWorkflow)
    setTask(t.description)
    setTasks((prev) => prev.map((task) => task.id === t.id ? { ...task, status: 'running' } : task))
    if (!running) runTask({ description: t.description, role: retryRole, workflow: retryWorkflow, resumeTaskId: t.id })
  }

  function exportLogs() {
    if (!log.length) return
    const text = log.map((e) => `[${new Date(e.ts).toLocaleTimeString()}] ${TYPE_PREFIX[e.type]} ${e.message}${e.data ? ' ' + JSON.stringify(e.data) : ''}`).join('\n')
    const blob = new Blob([text], { type: 'text/plain' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = `raz-log-${Date.now()}.txt`; a.click()
    URL.revokeObjectURL(url)
  }

  function copyLog() {
    if (!log.length) return
    const text = log.map((e) => `[${new Date(e.ts).toLocaleTimeString()}] ${TYPE_PREFIX[e.type]} ${e.message}`).join('\n')
    navigator.clipboard.writeText(text).catch(() => {})
  }

  const canRun    = !running && !!selectedRepo && !!task.trim() && (!!selectedRepo.local_path || !!localPath.trim())
  const canQueue  = !!selectedRepo && !!task.trim() && (!!selectedRepo.local_path || !!localPath.trim())
  const activeRole = ROLES[role]

  // Parse files_changed JSON safely
  function parseFiles(raw: string | null): string[] {
    if (!raw) return []
    try { return JSON.parse(raw) } catch { return [] }
  }

  return (
    <div className="h-screen flex flex-col bg-gray-50 text-gray-900 font-sans overflow-hidden">

      {/* ── Nav ─────────────────────────────────────────────────────────── */}
      <header className="h-11 flex-shrink-0 bg-white border-b border-gray-200 flex items-center justify-between px-4">
        <div className="flex items-center gap-2.5">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" className="w-7 h-7 flex-shrink-0">
            <polygon points="56,32 44,11.2 20,11.2 8,32 20,52.8 44,52.8" fill="#818cf8"/>
            <polygon points="50,32 40,15.6 24,15.6 14,32 24,48.4 40,48.4" fill="#0a0a0a"/>
            <polygon points="32,20 44,32 32,44 20,32" fill="#818cf8"/>
            <line x1="32" y1="20" x2="32" y2="11.2" stroke="#0a0a0a" strokeWidth="1.5"/>
            <line x1="44" y1="32" x2="56" y2="32" stroke="#0a0a0a" strokeWidth="1.5"/>
            <line x1="32" y1="44" x2="32" y2="52.8" stroke="#0a0a0a" strokeWidth="1.5"/>
            <line x1="20" y1="32" x2="8" y2="32" stroke="#0a0a0a" strokeWidth="1.5"/>
            <circle cx="32" cy="32" r="4" fill="#0a0a0a"/>
            <circle cx="32" cy="32" r="2" fill="#818cf8"/>
          </svg>
          <span className="text-base font-bold tracking-tight text-gray-900" style={{ fontFamily: 'var(--font-display)' }}>RAZ</span>
          <span className="text-[10px] text-gray-400">Archon Systems · Agent v2</span>
          {razMode !== 'standard' && (
            <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${razMode === 'autonomous' ? 'bg-violet-600 text-white' : 'bg-amber-500 text-white'}`}>
              {razMode === 'autonomous' ? '⚡ Autonomous' : '◎ Supervised'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Mode toggle */}
          <div className="flex items-center rounded-md border border-gray-200 overflow-hidden">
            {([
              { key: 'standard',   label: 'Directed',   tip: 'RAZ detects role & workflow, shows it to you, waits for approval before running.' },
              { key: 'supervised', label: 'Supervised',  tip: 'RAZ decides role & workflow, handoffs auto-chain. Questions still reach you.' },
              { key: 'autonomous', label: 'Autonomous',  tip: 'RAZ runs everything — detects, chains, skips questions. You just watch and review PRs.' },
            ] as const).map(({ key: m, label, tip }) => (
              <button key={m} onClick={() => changeMode(m)} title={tip}
                className={`px-3 py-1 text-[9px] font-semibold tracking-wide transition-colors ${razMode === m ? m === 'autonomous' ? 'bg-violet-600 text-white' : m === 'supervised' ? 'bg-amber-500 text-white' : 'bg-gray-900 text-white' : 'text-gray-500 hover:bg-gray-50'}`}>
                {label}
              </button>
            ))}
          </div>
          {owner && (
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
              <span className="text-xs text-gray-500">{owner}</span>
            </div>
          )}
        </div>
      </header>

      {/* ── Body ────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0">

        {/* ── Left panel ──────────────────────────────────────────────── */}
        <div className="w-72 flex-shrink-0 flex flex-col border-r border-gray-200 bg-white overflow-y-auto">
          <div className="flex flex-col gap-3 p-3">

            {/* 1 · Repository */}
            <div>
              <label className="block text-[9px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Repository</label>
              {loadingRepos ? (
                <div className="h-8 bg-gray-100 rounded-md animate-pulse" />
              ) : (
                <select value={selectedRepo?.id ?? ''} onChange={(e) => setSelectedRepo(repos.find((r) => r.id === Number(e.target.value)) ?? null)} className="w-full bg-white border border-gray-200 rounded-md px-2.5 py-1.5 text-xs text-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-900">
                  <option value="">Select repository...</option>
                  {repos.map((r) => <option key={r.id} value={r.id}>{r.github_repo}</option>)}
                </select>
              )}
              {selectedRepo && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  <span className="text-[9px] bg-gray-100 text-gray-500 rounded-full px-2 py-0.5">{selectedRepo.default_branch}</span>
                  {selectedRepo.local_path
                    ? <span className="text-[9px] bg-gray-100 text-gray-500 rounded-full px-2 py-0.5 font-mono truncate max-w-[200px]">{selectedRepo.local_path}</span>
                    : <span className="text-[9px] bg-amber-50 text-amber-700 rounded-full px-2 py-0.5 border border-amber-200">⚠ path not set — expand Options below</span>
                  }
                </div>
              )}
            </div>

            {/* 2 · Task input */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest">Task</label>
                {dispatch && task.trim().length >= 8 && (
                  <span className={`text-[8px] font-semibold px-1.5 py-0.5 rounded-full transition-all ${dispatch.confidence === 'high' ? 'text-green-700 bg-green-100' : dispatch.confidence === 'medium' ? 'text-blue-700 bg-blue-100' : 'text-gray-500 bg-gray-100'}`}>
                    {dispatch.confidence === 'high' ? '●' : dispatch.confidence === 'medium' ? '◐' : '○'} {dispatch.confidence}
                  </span>
                )}
              </div>
              <textarea value={task} onChange={(e) => handleTaskInput(e.target.value)} rows={6}
                placeholder="Describe what you need — RAZ detects the right agent automatically..."
                className="w-full bg-gray-50 border border-gray-200 rounded-md px-2.5 py-2 text-xs text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 resize-none leading-relaxed" />

              {/* Dispatch chip */}
              {dispatch && task.trim().length >= 8 && (
                <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                  <div className="flex items-center gap-1.5 bg-gray-50 border border-gray-200 rounded px-2 py-1">
                    <span className="text-[9px] font-bold" style={{ color: ROLE_COLORS_CSS[dispatch.role] ?? '#6366f1' }}>{dispatch.role}</span>
                    <span className="text-[8px] text-gray-300">·</span>
                    <span className="text-[9px] text-gray-500">{dispatch.workflow}</span>
                  </div>
                  <span className="text-[8px] text-gray-400 italic flex-1">{dispatch.reason}</span>
                  <button onClick={() => { setDispatch(null); cancelCountdown(); setShowOptions(true) }}
                    className="text-[8px] text-gray-400 hover:text-gray-700 underline">override</button>
                </div>
              )}

              {/* Countdown */}
              {dispatchCountdown !== null && (
                <div className="mt-1.5 flex items-center justify-between bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5">
                  <span className="text-[9px] text-amber-700 font-medium">
                    Running in {dispatchCountdown}s — {dispatch?.role} · {dispatch?.workflow}
                  </span>
                  <button onClick={cancelCountdown} className="text-[8px] font-semibold text-amber-600 hover:text-amber-800 border border-amber-300 rounded px-1.5 py-0.5 hover:bg-amber-100 transition-colors">
                    Cancel
                  </button>
                </div>
              )}
            </div>

            {/* 3 · Run / Pause / Stop */}
            <div className="flex gap-1.5">
              <button onClick={handleRun} disabled={!canRun} className="flex-1 py-2.5 rounded-md text-xs font-bold tracking-wide transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-white"
                style={{ background: canRun && !running ? (dispatch ? ROLE_COLORS_CSS[dispatch.role] ?? activeRole.color : activeRole.color) : '#111827' }}>
                {running
                  ? <span className="flex items-center justify-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />{role} working...</span>
                  : dispatch ? `Run ${dispatch.role}` : `Run ${role}`}
              </button>
              {!running && <button onClick={addToQueue} disabled={!canQueue} title="Add to queue" className="px-2.5 py-2 bg-white border border-gray-200 text-gray-500 text-[10px] font-medium rounded-md hover:border-gray-400 hover:text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">+Q</button>}
              {running && !isPaused && <button onClick={handlePause} className="px-2.5 py-2 bg-amber-500 text-white text-[10px] font-semibold rounded-md hover:bg-amber-600 transition-colors">Pause</button>}
              {running && isPaused  && <button onClick={handleResume} className="px-2.5 py-2 bg-green-600 text-white text-[10px] font-semibold rounded-md hover:bg-green-700 transition-colors animate-pulse">Resume</button>}
              {running && <button onClick={() => { handleResume(); abortRef.current?.abort(); setRunning(false) }} className="px-3 py-2 bg-red-600 text-white text-xs font-semibold rounded-md hover:bg-red-700 transition-colors">Stop</button>}
            </div>

            {/* 4 · Options collapsible (Role, Workflow, Issue, Local path) */}
            <div className="border border-gray-200 rounded-md overflow-hidden">
              <button onClick={() => setShowOptions((v) => !v)}
                className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 hover:bg-gray-100 transition-colors">
                <span className="text-[9px] font-semibold text-gray-500 uppercase tracking-widest">⚙ Options</span>
                <div className="flex items-center gap-2">
                  {!showOptions && (
                    <span className="text-[9px] text-gray-400">{role} · {workflow}</span>
                  )}
                  <span className="text-[9px] text-gray-400">{showOptions ? '▲' : '▼'}</span>
                </div>
              </button>

              {showOptions && (
                <div className="px-3 py-2.5 flex flex-col gap-3 border-t border-gray-100">

                  {/* Local path (only if missing) */}
                  {selectedRepo && !selectedRepo.local_path && (
                    <div>
                      <label className="block text-[9px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Local Path</label>
                      <div className="flex gap-1.5">
                        <input value={localPath} onChange={(e) => setLocalPath(e.target.value)} placeholder={`C:\\Projects\\${selectedRepo.github_repo}`} className="flex-1 bg-white border border-gray-200 rounded-md px-2.5 py-1.5 text-[10px] font-mono placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900" />
                        <button onClick={saveLocalPath} className="px-2.5 py-1.5 bg-gray-900 text-white text-[10px] font-medium rounded-md hover:bg-gray-700 transition-colors">Save</button>
                      </div>
                    </div>
                  )}

                  {/* Agent Role */}
                  <div>
                    <label className="block text-[9px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Agent Role</label>
                    <div className="flex gap-1">
                      {ROLE_IDS.map((r) => {
                        const def = ROLES[r]; const active = role === r
                        return (
                          <button key={r} onClick={() => { setRole(r); setWorkflow((prev) => ROLE_WORKFLOWS[r].includes(prev) ? prev : ROLE_DEFAULT_WORKFLOW[r]); setDispatch(null) }}
                            title={def.description} className="flex-1 py-1.5 rounded-md border text-[9px] font-bold tracking-wide transition-all"
                            style={active ? { background: def.color, borderColor: def.color, color: '#fff' } : { background: '#fff', borderColor: '#e5e7eb', color: '#9ca3af' }}>
                            {def.badge}
                          </button>
                        )
                      })}
                    </div>
                    <p className="text-[9px] text-gray-400 mt-1 leading-snug">{activeRole.description}</p>
                  </div>

                  {/* Workflow */}
                  <div>
                    <label className="block text-[9px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Workflow</label>
                    <div className="flex flex-wrap gap-1">
                      {WORKFLOWS.filter((w) => ROLE_WORKFLOWS[role].includes(w.value)).map((w) => (
                        <button key={w.value} onClick={() => setWorkflow(w.value)} className={`py-1.5 px-3 rounded-md border text-[10px] font-medium transition-colors ${workflow === w.value ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'}`}>
                          {w.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Issue picker (only for fix workflow) */}
                  {workflow === 'fix' && selectedRepo && (
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest">Linked Issue</label>
                        <button onClick={() => syncIssues(selectedRepo)} disabled={syncingIssues} className="text-[9px] text-blue-600 hover:text-blue-800 disabled:text-gray-400">{syncingIssues ? 'syncing...' : '↻ sync'}</button>
                      </div>
                      {issues.length === 0 ? (
                        <p className="text-[10px] text-gray-400">{syncingIssues ? 'Loading...' : 'No open issues.'}</p>
                      ) : (
                        <select value={selectedIssue?.id ?? ''} onChange={(e) => setSelectedIssue(issues.find((i) => i.id === Number(e.target.value)) ?? null)} className="w-full bg-white border border-gray-200 rounded-md px-2.5 py-1.5 text-[10px] text-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-900">
                          <option value="">No issue — describe in task box</option>
                          {issues.map((i) => <option key={i.id} value={i.id}>#{i.number} — {i.title}</option>)}
                        </select>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 5 · Quick Tasks collapsible (Self-Improve + Scaffold) */}
            {selectedRepo?.local_path && (
              <div className="border border-gray-200 rounded-md overflow-hidden">
                <button onClick={() => setShowQuickTasks((v) => !v)}
                  className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 hover:bg-gray-100 transition-colors">
                  <span className="text-[9px] font-semibold text-gray-500 uppercase tracking-widest">⚡ Quick Tasks</span>
                  <span className="text-[9px] text-gray-400">{showQuickTasks ? '▲' : '▼'}</span>
                </button>

                {showQuickTasks && (
                  <div className="border-t border-gray-100">
                    {/* Scaffold AGENTS.md */}
                    <button
                      onClick={() => { setRole('RAZ-Ops'); setWorkflow('strategy'); setTask("Read package.json, README, and config files to understand the project stack, then write an AGENTS.md file documenting: framework and version, key commands (dev, build, test, lint), database and migration conventions, required environment variables, and any critical rules an AI agent must follow when working in this codebase.") }}
                      className="w-full text-left px-3 py-2 hover:bg-indigo-50 border-b border-gray-100 transition-colors">
                      <span className="text-[9px] font-semibold text-indigo-600">⊞ Scaffold AGENTS.md</span>
                      <p className="text-[8px] text-gray-400 mt-0.5">Document this repo's stack and conventions</p>
                    </button>

                    {/* Self-Improve presets */}
                    <div className="px-3 pt-2 pb-1">
                      <span className="text-[8px] font-semibold text-violet-400 uppercase tracking-widest">Self-Improve</span>
                    </div>
                    {[
                      { label: 'Full system audit',    role: 'RAZ-Ops' as RoleId, workflow: 'self',     desc: 'Audit the RAZ codebase (lib/agent-cc.ts, lib/mcp-server.ts, lib/db.ts, app/page.tsx) for gaps, bugs, and missing capabilities. Write a findings report with mcp__raz__generate_report. Then handoff to RAZ-Dev to implement the highest-priority improvement.' },
                      { label: 'Write RAZ tests',      role: 'RAZ-QA'  as RoleId, workflow: 'test',     desc: 'Examine lib/db.ts, lib/agent-cc.ts, lib/mcp-server.ts, and app/api/ routes. Write comprehensive tests for any untested functions — DB migrations, config functions, API routes. Use Vitest. All tests must pass.' },
                      { label: 'Improve system prompt',role: 'RAZ-Ops' as RoleId, workflow: 'self',     desc: 'Read lib/agent-cc.ts buildSystemPrompt() function. Analyze the current system prompt for gaps in agent instructions. Propose and implement improvements to the MANDATORY PHASE ORDER, tool descriptions, and quality rules. Ask user before editing agent-cc.ts core loop.' },
                      { label: 'Update AGENTS.md',     role: 'RAZ-Ops' as RoleId, workflow: 'strategy', desc: 'Read all files in lib/ and app/api/ to understand every capability RAZ has. Update or create AGENTS.md documenting the full tech stack, all available MCP tools with descriptions, key environment variables, and any rules an agent must follow when working in this repo.' },
                    ].map((q) => (
                      <button key={q.label} onClick={() => { setRole(q.role); setWorkflow(q.workflow); setTask(q.desc) }}
                        className="w-full text-left px-3 py-2 hover:bg-violet-50 border-t border-gray-100 transition-colors">
                        <span className="text-[9px] font-semibold text-violet-600">{q.label}</span>
                        <p className="text-[8px] text-gray-400 mt-0.5 leading-snug line-clamp-1">{q.desc.slice(0, 56)}…</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 6 · Queue */}
            {queue.length > 0 && (
              <div className="border border-gray-200 rounded-md overflow-hidden">
                <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                  <span className="text-[9px] font-semibold text-gray-500 uppercase tracking-widest">Queue</span>
                  <span className="text-[9px] text-gray-400 bg-gray-200 rounded-full px-1.5 py-0.5">{queue.length}</span>
                </div>
                {queue.map((item, i) => (
                  <div key={item.id} className="flex items-start gap-2 px-3 py-2 border-b border-gray-100 last:border-0">
                    <span className="text-[8px] text-gray-400 font-mono mt-0.5 flex-shrink-0">{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-[8px] font-bold" style={{ color: ROLES[item.role].color }}>{ROLES[item.role].badge}</span>
                        <span className="text-[8px] text-gray-400">{item.workflow}</span>
                        {item.resumeTaskId && <span className="text-[8px] text-violet-400">handoff</span>}
                      </div>
                      <p className="text-[10px] text-gray-600 truncate">{item.description}</p>
                    </div>
                    <button onClick={() => setQueue((prev) => prev.filter((q) => q.id !== item.id))} className="text-gray-300 hover:text-red-500 text-[10px] flex-shrink-0 transition-colors">✕</button>
                  </div>
                ))}
              </div>
            )}

          </div>
        </div>

        {/* ── Right panel ─────────────────────────────────────────────── */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden">

          {/* Agent Log */}
          <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden">
            <div className="h-9 flex-shrink-0 bg-white border-b border-gray-200 flex items-center justify-between px-4">
              <span className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest">Agent Log</span>
              <div className="flex items-center gap-3">
                {log.length > 0 && !running && (
                  <>
                    <button onClick={copyLog} className="text-[9px] text-gray-400 hover:text-gray-600 transition-colors" title="Copy log to clipboard">⎘ copy</button>
                    <button onClick={exportLogs} className="text-[9px] text-gray-400 hover:text-gray-600 transition-colors" title="Export log as .txt">↓ export</button>
                  </>
                )}
                {prUrl && <a href={prUrl} target="_blank" rel="noreferrer" className="text-[10px] text-green-700 font-semibold underline underline-offset-2">✓ View PR ↗</a>}
                {CC_MODE
                  ? rateLimitResetAt && rateLimitSecondsLeft > 0
                    ? <span className="text-[10px] font-mono text-amber-500">limit — {Math.floor(rateLimitSecondsLeft / 60)}m {String(rateLimitSecondsLeft % 60).padStart(2, '0')}s</span>
                    : null
                  : (running || finalCost !== null) && <span className="text-[10px] font-mono text-gray-400">${(finalCost ?? liveCost).toFixed(4)}</span>
                }
                {running && (
                  <>
                    <span className="text-[10px] font-mono text-gray-400">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                  </>
                )}
              </div>
            </div>
            {isPaused && running && (
              <div className="flex-shrink-0 bg-amber-50 border-b border-amber-200 px-4 py-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0" />
                  <span className="text-[10px] font-semibold text-amber-700">Agent paused — will resume at next tool boundary</span>
                </div>
                <button onClick={handleResume} className="px-2 py-0.5 text-[9px] font-semibold rounded bg-amber-500 text-white hover:bg-amber-600 transition-colors">Resume</button>
              </div>
            )}
            {pendingQuestionId && !answeredQuestions.has(pendingQuestionId) && (
              <div className="flex-shrink-0 bg-orange-50 border-b border-orange-200 px-4 py-2 flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse flex-shrink-0" />
                <span className="text-[10px] font-semibold text-orange-700">Agent is waiting for your answer — scroll down in the log</span>
              </div>
            )}
            <div ref={logRef} className="flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-px bg-gray-50 font-mono text-[10px]">
              {log.length === 0 && !running && (
                <div className="h-full flex items-center justify-center"><span className="text-xs text-gray-300">Select a repo, set a task, and run.</span></div>
              )}
              {log.map((entry, i) => {
                const isDelegated = entry.data?.delegated === true
                const isDelStart  = entry.type === 'delegation' && !entry.data?.complete
                const isDelEnd    = entry.type === 'delegation' && entry.data?.complete
                const handoffCard = entry.type === 'handoff' && entry.data?.taskId
                  ? handoffSuggestions.find((h) => h.taskId === entry.data?.taskId)
                  : null
                return (
                  <React.Fragment key={i}>
                    <div className={`flex gap-2 leading-relaxed overflow-hidden ${TYPE_STYLES[entry.type]} ${isDelegated ? 'pl-4 opacity-75' : ''} ${isDelStart ? 'mt-1 border-l-2 border-violet-300 pl-2' : ''} ${isDelEnd ? 'border-l-2 border-violet-300 pl-2 mb-1' : ''}`}>
                      <span className="shrink-0 text-[8px] text-gray-300 w-14 text-right pt-px">
                        {new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                      <span className="shrink-0 w-3 text-center">{TYPE_PREFIX[entry.type]}</span>
                      <span className="min-w-0 flex-1 break-all [overflow-wrap:anywhere]">
                        {entry.type === 'tool_call'
                          ? <><span className="font-semibold">{entry.message}</span>{entry.data?.input ? ` — ${JSON.stringify(entry.data.input).slice(0, 120)}` : ''}</>
                          : entry.type === 'plan'
                          ? <span className="text-indigo-500 font-medium cursor-pointer hover:underline" onClick={() => setPlanOpen(true)}>Plan created → view</span>
                          : entry.message}
                      </span>
                    </div>
                    {handoffCard && (
                      <div className="ml-[68px] my-1.5 font-sans">
                        <div className="border border-amber-200 rounded-md overflow-hidden bg-amber-50 max-w-sm">
                          <div className="px-3 py-1.5 flex items-center gap-1.5 border-b border-amber-200">
                            <span className="text-[9px] font-bold text-amber-700">⟶ HANDOFF SUGGESTION</span>
                            <span className="text-[8px] text-amber-500 ml-auto">{handoffCard.fromRole}</span>
                          </div>
                          <div className="px-3 py-2">
                            <div className="flex items-center gap-1.5 mb-1">
                              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ background: ROLES[handoffCard.role]?.color ?? '#6b7280', color: '#fff' }}>{ROLES[handoffCard.role]?.badge ?? handoffCard.role}</span>
                              <span className="text-[9px] text-amber-600">{handoffCard.workflow}</span>
                            </div>
                            <p className="text-[10px] text-gray-700 leading-snug mb-2 line-clamp-2">{handoffCard.description}</p>
                            <div className="flex gap-1.5">
                              <button onClick={() => acceptHandoff(handoffCard)} className="flex-1 py-1 bg-amber-600 text-white text-[10px] font-semibold rounded hover:bg-amber-700 transition-colors">Accept → Run {handoffCard.role}</button>
                              <button onClick={() => dismissHandoff(handoffCard.taskId)} className="px-2 py-1 text-[10px] text-amber-600 border border-amber-300 rounded hover:bg-amber-100 transition-colors">Dismiss</button>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                    {entry.type === 'ask_user' && entry.data?.questionId && (() => {
                      const qId      = entry.data.questionId as string
                      const question = entry.data.question as string
                      const options  = entry.data.options as Array<{ label: string; description?: string }> | undefined
                      const isAnswered = answeredQuestions.has(qId)
                      const myAnswer   = answeredQuestions.get(qId)
                      if (isAnswered) {
                        return (
                          <div className="ml-[68px] my-1 font-sans">
                            <div className="border border-green-200 rounded-md bg-green-50 px-3 py-1.5 max-w-sm">
                              <span className="text-[10px] text-green-700">You answered: <strong className="font-semibold">{myAnswer}</strong></span>
                            </div>
                          </div>
                        )
                      }
                      return (
                        <div className="ml-[68px] my-1.5 font-sans">
                          <div className="border border-orange-300 rounded-md overflow-hidden bg-orange-50 max-w-md shadow-sm">
                            <div className="px-3 py-1.5 flex items-center gap-1.5 border-b border-orange-200 bg-orange-100">
                              <span className="text-[9px] font-bold text-orange-700">? AGENT QUESTION</span>
                              <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse ml-auto" />
                            </div>
                            <div className="px-3 py-2.5">
                              <p className="text-[11px] text-gray-800 font-medium mb-2.5 leading-snug">{inlineRender(question)}</p>
                              {options && options.length > 0 ? (
                                <div className="flex flex-col gap-1.5">
                                  {options.map((opt) => (
                                    <button key={opt.label} onClick={() => submitAnswer(qId, opt.label)}
                                      className="text-left px-2.5 py-2 border border-orange-200 rounded-md text-[10px] text-gray-700 bg-white hover:bg-orange-100 hover:border-orange-400 transition-colors">
                                      <span className="font-semibold text-gray-800">{inlineRender(opt.label)}</span>
                                      {opt.description && <span className="text-gray-500 ml-1">— {inlineRender(opt.description)}</span>}
                                    </button>
                                  ))}
                                </div>
                              ) : (
                                <div className="flex gap-1.5">
                                  <input
                                    value={questionInputs[qId] ?? ''}
                                    onChange={(e) => setQuestionInputs((prev) => ({ ...prev, [qId]: e.target.value }))}
                                    onKeyDown={(e) => { if (e.key === 'Enter') submitAnswer(qId, questionInputs[qId] ?? '') }}
                                    placeholder="Type your answer..."
                                    autoFocus
                                    className="flex-1 text-[10px] border border-orange-200 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-orange-400 bg-white placeholder-gray-400"
                                  />
                                  <button onClick={() => submitAnswer(qId, questionInputs[qId] ?? '')}
                                    className="px-3 py-1.5 bg-orange-500 text-white text-[10px] font-semibold rounded-md hover:bg-orange-600 transition-colors">
                                    Send
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    })()}
                  </React.Fragment>
                )
              })}
              {running && (
                <div className={`flex gap-2 animate-pulse ${isPaused ? 'text-amber-400' : pendingQuestionId && !answeredQuestions.has(pendingQuestionId) ? 'text-orange-400' : 'text-gray-300'}`}>
                  <span className="w-14 text-right text-[8px]" />
                  <span className="w-3 text-center">{isPaused ? '‖' : pendingQuestionId && !answeredQuestions.has(pendingQuestionId) ? '?' : '·'}</span>
                  <span>{isPaused ? 'paused...' : pendingQuestionId && !answeredQuestions.has(pendingQuestionId) ? 'waiting for your answer...' : 'working...'}</span>
                </div>
              )}
            </div>
          </div>

          {/* Bottom panel */}
          <div className="flex-shrink-0 border-gray-200 flex flex-col" style={{ height: panelH }}>
            {/* Drag-to-resize handle */}
            <div onMouseDown={startPanelResize}
              className="h-1.5 flex-shrink-0 bg-gray-100 hover:bg-indigo-300 cursor-row-resize transition-colors border-t border-gray-200 group flex items-center justify-center">
              <div className="w-8 h-0.5 rounded-full bg-gray-300 group-hover:bg-indigo-400 transition-colors" />
            </div>
            <div className="h-9 flex-shrink-0 bg-white border-b border-gray-200 flex items-center">
              {(['history', 'memory', 'comms', 'issues', 'reports', 'brain'] as const).map((tab) => (
                <button key={tab} onClick={() => {
                  setBottomTab(tab)
                  if (tab === 'memory'  && selectedRepo) loadMemory(selectedRepo.id)
                  if (tab === 'comms'   && selectedRepo) loadMessages(selectedRepo.id)
                  if (tab === 'issues'  && selectedRepo) loadAllIssues(selectedRepo.id, issueFilter)
                  if (tab === 'reports') loadReports()
                }}
                  className={`h-full px-4 text-[9px] font-semibold uppercase tracking-widest border-b-2 transition-colors capitalize ${bottomTab === tab ? tab === 'brain' ? 'border-violet-500 text-violet-600' : 'border-gray-900 text-gray-900' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>
                  {tab}
                  {tab === 'history' && tasks.length > 0 && <span className="ml-1.5 text-[8px] text-gray-400">{tasks.length}</span>}
                  {tab === 'memory'  && memory.length > 0 && <span className="ml-1.5 text-[8px] text-gray-400">{memory.length}</span>}
                  {tab === 'comms'   && messages.length > 0 && <span className="ml-1.5 text-[8px] text-violet-400">{messages.length}</span>}
                  {tab === 'issues'  && allIssues.length > 0 && <span className="ml-1.5 text-[8px] text-gray-400">{allIssues.length}</span>}
                  {tab === 'reports' && reports.length > 0 && <span className="ml-1.5 text-[8px] text-amber-500">{reports.length}</span>}
                </button>
              ))}
            </div>

            {/* History tab */}
            {bottomTab === 'history' && (
              <div className="flex-1 flex flex-col overflow-hidden bg-white">
                {tasks.length > 3 && (
                  <div className="flex-shrink-0 px-3 py-1.5 border-b border-gray-100">
                    <input value={historyFilter} onChange={(e) => setHistoryFilter(e.target.value)} placeholder="Filter by description, role, or status..." className="w-full text-[10px] bg-gray-50 border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-gray-400 placeholder-gray-300" />
                  </div>
                )}
                <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
                  {(() => {
                    const filtered = historyFilter.trim()
                      ? tasks.filter((t) =>
                          t.description.toLowerCase().includes(historyFilter.toLowerCase()) ||
                          (t.role ?? '').toLowerCase().includes(historyFilter.toLowerCase()) ||
                          t.status.toLowerCase().includes(historyFilter.toLowerCase())
                        )
                      : tasks
                    if (filtered.length === 0) return (
                      <div className="h-full flex items-center justify-center"><span className="text-xs text-gray-300">{selectedRepo ? (historyFilter ? 'No matching tasks.' : 'No tasks yet.') : 'Select a repo.'}</span></div>
                    )
                    return filtered.map((t) => {
                      const files = parseFiles(t.files_changed)
                      const isChild = !!t.parent_task_id
                      return (
                        <div key={t.id} className="flex items-center group hover:bg-gray-50 transition-colors">
                          <button onClick={() => { setSelectedTask(t); setPrStatus(null); setPrDetails(null); if (t.pr_url) { loadPrStatus(t.id); loadPRDetails(t.pr_url) } }} className="flex-1 flex items-center gap-3 px-4 py-2.5 text-left min-w-0">
                            {isChild && <span className="text-[8px] text-violet-400 flex-shrink-0">↳</span>}
                            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-0.5 ${STATUS_DOT[t.status] ?? 'bg-gray-300'}`} />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className={`text-[9px] font-bold uppercase tracking-wide ${STATUS_TEXT[t.status] ?? 'text-gray-400'}`}>{t.status}</span>
                                <span className="text-[9px] text-gray-400">{t.role ?? 'RAZ-Dev'} · {t.workflow ?? 'feature'}</span>
                                {files.length > 0 && <span className="text-[8px] text-gray-300 font-mono">{files.length}f</span>}
                                <span className="text-[9px] text-gray-300 ml-auto">{new Date(t.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                              </div>
                              <p className="text-[10px] text-gray-600 truncate mt-0.5">{t.description}</p>
                              {t.status === 'failed' && t.error && <p className="text-[9px] text-red-400 truncate mt-0.5">{t.error}</p>}
                            </div>
                            <span className="text-gray-300 text-[10px] flex-shrink-0">›</span>
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); handleDeleteTask(t.id) }} className="px-3 py-2.5 text-[10px] text-gray-200 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0">✕</button>
                        </div>
                      )
                    })
                  })()}
                </div>
              </div>
            )}

            {/* Memory tab */}
            {bottomTab === 'memory' && (
              <div className="flex-1 overflow-y-auto bg-white divide-y divide-gray-100">
                {!selectedRepo ? (
                  <div className="h-full flex items-center justify-center"><span className="text-xs text-gray-300">Select a repo.</span></div>
                ) : memory.length === 0 ? (
                  <div className="h-full flex items-center justify-center flex-col gap-1">
                    <span className="text-xs text-gray-300">No memories yet.</span>
                    <span className="text-[10px] text-gray-300">Run a task — RAZ will save what it learns here.</span>
                  </div>
                ) : memory.map((m) => <MemoryEntry key={m.key} row={m} onDelete={handleDeleteMemory} onSave={handleSaveMemory} />)}
              </div>
            )}

            {/* Comms tab */}
            {bottomTab === 'comms' && (
              <div className="flex-1 overflow-y-auto bg-white divide-y divide-gray-100">
                {!selectedRepo ? (
                  <div className="h-full flex items-center justify-center"><span className="text-xs text-gray-300">Select a repo.</span></div>
                ) : messages.length === 0 ? (
                  <div className="h-full flex items-center justify-center flex-col gap-1">
                    <span className="text-xs text-gray-300">No agent communications yet.</span>
                    <span className="text-[10px] text-gray-300">Agent delegations and handoffs appear here.</span>
                  </div>
                ) : messages.map((m) => (
                  <div key={m.id} className="px-4 py-2.5 hover:bg-gray-50">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[9px] font-bold text-violet-600">{m.from_role}</span>
                      <span className="text-[9px] text-gray-400">{m.message_type === 'handoff' ? '⟶' : '⇒'}</span>
                      <span className="text-[9px] font-bold" style={{ color: ROLES[m.to_role as RoleId]?.color ?? '#6b7280' }}>{m.to_role}</span>
                      <span className={`text-[8px] px-1.5 py-px rounded-full border font-semibold uppercase tracking-wide ml-1 ${MSG_TYPE_COLORS[m.message_type] ?? 'text-gray-500 bg-gray-50 border-gray-200'}`}>{m.message_type}</span>
                      <span className="text-[8px] text-gray-300 ml-auto">{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    <p className="text-[10px] text-gray-600 leading-relaxed line-clamp-2">{m.message}</p>
                    {m.result && (
                      <p className="text-[10px] text-green-600 mt-0.5 leading-relaxed line-clamp-1">↳ {m.result}</p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Issues tab */}
            {bottomTab === 'issues' && (
              <div className="flex-1 flex flex-col overflow-hidden bg-white">
                <div className="flex items-center gap-2 px-4 py-1.5 border-b border-gray-100 flex-shrink-0">
                  {(['open', 'closed'] as const).map((s) => (
                    <button key={s} onClick={() => { setIssueFilter(s); if (selectedRepo) loadAllIssues(selectedRepo.id, s) }}
                      className={`text-[9px] font-semibold px-2 py-0.5 rounded-full transition-colors capitalize ${issueFilter === s ? 'bg-gray-900 text-white' : 'text-gray-400 hover:text-gray-600'}`}>
                      {s}
                    </button>
                  ))}
                  {selectedRepo && (
                    <button onClick={() => syncIssues(selectedRepo)} disabled={syncingIssues}
                      className="ml-auto text-[9px] text-blue-500 hover:text-blue-700 disabled:text-gray-400 transition-colors">
                      {syncingIssues ? 'syncing...' : '↻ sync'}
                    </button>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
                  {!selectedRepo ? (
                    <div className="h-full flex items-center justify-center"><span className="text-xs text-gray-300">Select a repo.</span></div>
                  ) : allIssues.length === 0 ? (
                    <div className="h-full flex items-center justify-center flex-col gap-1">
                      <span className="text-xs text-gray-300">No {issueFilter} issues synced.</span>
                      <span className="text-[10px] text-gray-300">Click ↻ sync to pull from GitHub.</span>
                    </div>
                  ) : allIssues.map((issue) => {
                    const labels: string[] = issue.labels ? (() => { try { return JSON.parse(issue.labels) } catch { return [] } })() : []
                    return (
                      <div key={issue.id} className="px-4 py-2.5 hover:bg-gray-50 group">
                        <div className="flex items-start gap-2">
                          <span className="text-[9px] font-mono text-gray-300 flex-shrink-0 mt-0.5">#{issue.number}</span>
                          <div className="flex-1 min-w-0">
                            <p className="text-[10px] font-medium text-gray-800 leading-snug line-clamp-1">{issue.title}</p>
                            {issue.body && <p className="text-[9px] text-gray-400 leading-relaxed line-clamp-1 mt-0.5">{issue.body}</p>}
                            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                              {labels.map((l) => (
                                <span key={l} className="text-[8px] px-1.5 py-px bg-blue-50 text-blue-600 border border-blue-100 rounded-full">{l}</span>
                              ))}
                              {issue.assignee && <span className="text-[8px] text-gray-400">@{issue.assignee}</span>}
                            </div>
                          </div>
                          <span className="text-[8px] text-gray-300 flex-shrink-0 mt-0.5">{new Date(issue.synced_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                        </div>
                        <div className="mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button onClick={() => {
                            setSelectedIssue(issue as unknown as typeof selectedIssue)
                            setWorkflow('fix')
                            setTask(issue.title)
                          }} className="text-[9px] text-indigo-500 hover:text-indigo-700 transition-colors">
                            → Use as task
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Reports tab */}
            {bottomTab === 'reports' && (
              <div className="flex-1 overflow-y-auto bg-white divide-y divide-gray-100">
                {reports.length === 0 ? (
                  <div className="h-full flex items-center justify-center flex-col gap-1">
                    <span className="text-xs text-gray-300">No reports yet.</span>
                    <span className="text-[10px] text-gray-300">RAZ-Sec and RAZ-Ops save reports here.</span>
                  </div>
                ) : reports.map((r) => {
                  const parts    = r.file.replace('.md', '').split('-')
                  const date     = parts.slice(0, 3).join('-')
                  const namePart = parts.slice(3).join(' ')
                  const kb       = (r.size / 1024).toFixed(1)
                  return (
                    <button key={r.file} onClick={() => openReportFile(r.file)}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-50 transition-colors group">
                      <span className="text-lg leading-none flex-shrink-0">📄</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-[10px] font-medium text-gray-800 leading-snug capitalize">{namePart}</p>
                        <p className="text-[9px] text-gray-400 mt-0.5">{date} · {kb} KB</p>
                      </div>
                      <span className="text-[9px] text-gray-300 group-hover:text-gray-500 transition-colors flex-shrink-0">→ open</span>
                    </button>
                  )
                })}
              </div>
            )}

            {/* Brain tab */}
            {bottomTab === 'brain' && (
              <div className="flex-1 overflow-hidden p-2">
                <BrainView />
              </div>
            )}
          </div>

        </div>
      </div>

      {/* ── Plan Sidebar ──────────────────────────────────────────────── */}
      {activePlan && (
        <>
          <div className={`fixed right-0 top-11 bottom-0 w-80 bg-white border-l border-gray-200 z-30 flex flex-col shadow-lg transition-transform duration-200 ${planOpen ? 'translate-x-0' : 'translate-x-full'}`}>
            <div className="h-9 flex-shrink-0 flex items-center justify-between px-3 border-b border-gray-200 bg-indigo-50">
              <span className="text-[9px] font-semibold text-indigo-500 uppercase tracking-widest">⊞ {role} Plan</span>
              <button onClick={() => setPlanOpen(false)} className="text-indigo-400 hover:text-indigo-700 text-sm leading-none transition-colors">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-3">
              <Markdown text={activePlan} className="text-[10px]" />
            </div>
          </div>
          {!planOpen && (
            <button onClick={() => setPlanOpen(true)} className="fixed right-0 top-28 z-30 bg-white border border-r-0 border-indigo-200 rounded-l-md shadow-sm hover:bg-indigo-50 transition-colors" style={{ writingMode: 'vertical-rl', textOrientation: 'mixed' }}>
              <span className="text-[8px] font-bold text-indigo-400 uppercase tracking-widest px-1 py-2">⊞ Plan</span>
            </button>
          )}
        </>
      )}

      {/* ── Report Viewer Modal ────────────────────────────────────────── */}
      {openReport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={() => setOpenReport(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0 bg-gray-50 rounded-t-2xl">
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-xl flex-shrink-0">📊</span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-gray-800 truncate capitalize">
                    {openReport.file.replace('.md', '').split('-').slice(3).join(' ')}
                  </p>
                  <p className="text-[9px] font-mono text-gray-400 mt-0.5">{openReport.file}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 ml-4">
                <button onClick={() => {
                  const blob = new Blob([openReport.content], { type: 'text/markdown' })
                  const url  = URL.createObjectURL(blob)
                  const a    = document.createElement('a'); a.href = url; a.download = openReport.file; a.click()
                  URL.revokeObjectURL(url)
                }} className="text-[10px] font-medium text-gray-500 hover:text-gray-800 transition-colors px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-white">
                  ↓ Download
                </button>
                <button onClick={() => setOpenReport(null)} className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-200 transition-colors text-sm">✕</button>
              </div>
            </div>
            {/* Body */}
            <div className="flex-1 overflow-y-auto px-8 py-6 min-h-0">
              <Markdown text={openReport.content} report={true} />
            </div>
          </div>
        </div>
      )}

      {/* ── Task Detail Modal ──────────────────────────────────────────── */}
      {selectedTask && (() => {
        const files = parseFiles(selectedTask.files_changed)
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'rgba(0,0,0,0.45)' }} onClick={() => setSelectedTask(null)}>
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[82vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
              {/* Modal header */}
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-200 flex-shrink-0">
                <div className="flex items-center gap-2.5">
                  <span className={`w-2 h-2 rounded-full ${STATUS_DOT[selectedTask.status] ?? 'bg-gray-300'}`} />
                  <span className={`text-xs font-bold uppercase tracking-wide ${STATUS_TEXT[selectedTask.status] ?? 'text-gray-500'}`}>{selectedTask.status}</span>
                  <span className="text-xs text-gray-400">{selectedTask.role ?? 'RAZ-Dev'} · {selectedTask.workflow ?? 'feature'}</span>
                  {selectedTask.issue_number && <span className="text-xs text-indigo-500">Issue #{selectedTask.issue_number}</span>}
                  {selectedTask.parent_task_id && <span className="text-[9px] text-violet-500 bg-violet-50 rounded px-1.5 py-0.5">↳ delegated</span>}
                </div>
                <div className="flex items-center gap-2">
                  {(selectedTask.status === 'failed' || selectedTask.status === 'complete') && (
                    <button onClick={() => handleRetry(selectedTask)} className="px-3 py-1 text-[10px] font-semibold rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors" title={selectedTask.status === 'failed' ? 'Resume from checkpoint' : 'Re-run this task'}>
                      ↺ {selectedTask.status === 'failed' ? 'Retry' : 'Re-run'}
                    </button>
                  )}
                  <button onClick={() => handleDeleteTask(selectedTask.id)} className="px-3 py-1 text-[10px] font-semibold rounded-md border border-red-100 text-red-400 hover:bg-red-50 transition-colors">Delete</button>
                  <button onClick={() => setSelectedTask(null)} className="text-gray-400 hover:text-gray-700 text-base leading-none transition-colors">✕</button>
                </div>
              </div>

              {/* Modal body */}
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                <div>
                  <div className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Task</div>
                  <p className="text-sm text-gray-800 leading-relaxed">{selectedTask.description}</p>
                </div>

                {selectedTask.pr_url && (
                  <div className="border border-gray-200 rounded-xl overflow-hidden">
                    {/* PR header */}
                    <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Pull Request</div>
                        {prDetails ? (
                          <div className="text-[11px] font-semibold text-gray-800 leading-snug">{prDetails.title}</div>
                        ) : (
                          <a href={selectedTask.pr_url} target="_blank" rel="noreferrer" className="text-[10px] text-blue-600 underline break-all">{selectedTask.pr_url}</a>
                        )}
                        {prDetails && (
                          <div className="mt-1 text-[9px] text-gray-400">
                            by <span className="text-gray-600 font-medium">{prDetails.author}</span>
                            {' · '}<span className="font-mono">{prDetails.headBranch}</span> → <span className="font-mono">{prDetails.baseBranch}</span>
                            {' · '}<a href={selectedTask.pr_url} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">#{prDetails.number}</a>
                          </div>
                        )}
                      </div>
                      {/* Status badges */}
                      <div className="flex flex-wrap gap-1.5 flex-shrink-0">
                        {prDetails ? (
                          <>
                            <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full border ${prDetails.merged ? 'text-violet-700 bg-violet-50 border-violet-200' : prDetails.state === 'open' ? 'text-green-700 bg-green-50 border-green-200' : 'text-gray-500 bg-gray-100 border-gray-200'}`}>
                              {prDetails.merged ? 'merged' : prDetails.state}
                            </span>
                            <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full border ${prDetails.ciStatus === 'passing' ? 'text-green-700 bg-green-50 border-green-200' : prDetails.ciStatus === 'failing' ? 'text-red-700 bg-red-50 border-red-200' : 'text-amber-700 bg-amber-50 border-amber-200'}`}>
                              CI: {prDetails.ciStatus}
                            </span>
                            {prDetails.approvals > 0 && (
                              <span className="text-[9px] font-bold px-2 py-0.5 rounded-full border text-green-700 bg-green-50 border-green-200">
                                {prDetails.approvals} approval{prDetails.approvals > 1 ? 's' : ''}
                              </span>
                            )}
                          </>
                        ) : prDetailsLoading ? (
                          <span className="text-[9px] text-gray-400 animate-pulse">loading...</span>
                        ) : null}
                      </div>
                    </div>

                    {/* PR body */}
                    {prDetails?.body && (
                      <div className="px-4 py-3 border-b border-gray-100">
                        <div className="text-[10px] text-gray-600 leading-relaxed whitespace-pre-wrap line-clamp-4">{prDetails.body}</div>
                      </div>
                    )}

                    {/* Action buttons */}
                    {prDetails && !prDetails.merged && (
                      <div className="px-4 py-2.5 border-b border-gray-100 flex items-center gap-2">
                        {prDetails.state === 'open' && (
                          <>
                            <button
                              onClick={() => handlePRAction('merge', selectedTask.pr_url!)}
                              disabled={!!prActionLoading}
                              className="px-3 py-1.5 text-[10px] font-semibold rounded-md bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 transition-colors"
                            >
                              {prActionLoading === 'merge' ? 'Merging...' : 'Squash & Merge'}
                            </button>
                            <button
                              onClick={() => handlePRAction('close', selectedTask.pr_url!)}
                              disabled={!!prActionLoading}
                              className="px-3 py-1.5 text-[10px] font-semibold rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors"
                            >
                              {prActionLoading === 'close' ? 'Closing...' : 'Close PR'}
                            </button>
                          </>
                        )}
                        {prDetails.state === 'closed' && (
                          <button
                            onClick={() => handlePRAction('reopen', selectedTask.pr_url!)}
                            disabled={!!prActionLoading}
                            className="px-3 py-1.5 text-[10px] font-semibold rounded-md border border-green-200 text-green-700 hover:bg-green-50 disabled:opacity-50 transition-colors"
                          >
                            {prActionLoading === 'reopen' ? 'Reopening...' : 'Reopen PR'}
                          </button>
                        )}
                        <button
                          onClick={() => loadPRDetails(selectedTask.pr_url!)}
                          disabled={prDetailsLoading}
                          className="ml-auto px-2.5 py-1.5 text-[9px] font-semibold rounded-md border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-50 transition-colors"
                        >
                          {prDetailsLoading ? '...' : 'Refresh'}
                        </button>
                      </div>
                    )}

                    {/* Files changed */}
                    {prDetails && prDetails.files.length > 0 && (
                      <div className="px-4 py-3 border-b border-gray-100">
                        <div className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest mb-2">Files Changed ({prDetails.files.length})</div>
                        <div className="space-y-0.5 max-h-40 overflow-y-auto">
                          {prDetails.files.map((f, i) => (
                            <div key={i} className="flex items-center gap-2 text-[10px]">
                              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${f.status === 'added' ? 'bg-green-400' : f.status === 'removed' ? 'bg-red-400' : 'bg-amber-400'}`} />
                              <span className="font-mono text-gray-600 flex-1 truncate">{f.filename}</span>
                              <span className="text-green-600 font-semibold flex-shrink-0">+{f.additions}</span>
                              <span className="text-red-500 font-semibold flex-shrink-0">-{f.deletions}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Comments */}
                    {prDetails && prDetails.comments.length > 0 && (
                      <div className="px-4 py-3">
                        <div className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest mb-2">Comments ({prDetails.comments.length})</div>
                        <div className="space-y-2 max-h-48 overflow-y-auto">
                          {prDetails.comments.map((c, i) => (
                            <div key={i} className="bg-gray-50 rounded-lg p-2.5 border border-gray-100">
                              <div className="flex items-center gap-1.5 mb-1">
                                <span className="text-[9px] font-semibold text-gray-700">{c.author}</span>
                                <span className="text-[8px] text-gray-400">{new Date(c.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                              </div>
                              <p className="text-[10px] text-gray-600 leading-relaxed whitespace-pre-wrap">{c.body}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {prDetailsLoading && !prDetails && (
                      <div className="px-4 py-4 text-center text-[10px] text-gray-400 animate-pulse">Loading PR details from GitHub...</div>
                    )}
                  </div>
                )}

                {selectedTask.summary && (
                  <div>
                    <div className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Summary</div>
                    <div className="bg-gray-50 rounded-lg p-3 border border-gray-100"><Markdown text={selectedTask.summary} /></div>
                  </div>
                )}

                {files.length > 0 && (
                  <div>
                    <div className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Files Changed ({files.length})</div>
                    <div className="bg-gray-50 rounded-lg p-3 border border-gray-100 space-y-0.5">
                      {files.map((f, i) => <p key={i} className="text-[10px] font-mono text-gray-600">{f}</p>)}
                    </div>
                  </div>
                )}

                {selectedTask.status === 'failed' && selectedTask.error && (
                  <div>
                    <div className="text-[9px] font-semibold text-red-400 uppercase tracking-widest mb-1">Error</div>
                    <div className="bg-red-50 rounded-lg p-3 border border-red-100">
                      <p className="text-[10px] text-red-600 font-mono leading-relaxed whitespace-pre-wrap">{selectedTask.error}</p>
                    </div>
                  </div>
                )}

                {selectedTask.plan && (
                  <div>
                    <div className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Plan</div>
                    <div className="bg-gray-50 rounded-lg p-3 border border-gray-100"><Markdown text={selectedTask.plan} /></div>
                  </div>
                )}

                <div className="text-[9px] text-gray-400">
                  {new Date(selectedTask.created_at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  {selectedTask.parent_task_id && <span className="ml-2 text-violet-400">· spawned by {selectedTask.parent_task_id.slice(0, 8)}…</span>}
                </div>
              </div>
            </div>
          </div>
        )
      })()}

    </div>
  )
}
