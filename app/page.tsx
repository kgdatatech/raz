'use client'

import { useState, useRef, useEffect } from 'react'
import { ROLES, ROLE_IDS, type RoleId, DEFAULT_ROLE } from '@/lib/roles'

interface RepoRow {
  id:             number
  github_owner:   string
  github_repo:    string
  local_path:     string | null
  default_branch: string
}

interface IssueRow {
  id:       number
  number:   number
  title:    string
  state:    string
  labels:   string | null
}

interface TaskRow {
  id:           string
  description:  string
  branch:       string
  status:       string
  workflow:     string
  role:         string | null
  issue_number: number | null
  plan:         string | null
  pr_url:       string | null
  summary:      string | null
  created_at:   string
}

interface LogEntry {
  type:    'thinking' | 'tool_call' | 'tool_result' | 'plan' | 'usage' | 'complete' | 'error'
  message: string
  data?:   Record<string, unknown>
  ts:      number
}

const WORKFLOWS = [
  { value: 'feature',  label: 'Feature'  },
  { value: 'fix',      label: 'Fix'      },
  { value: 'refactor', label: 'Refactor' },
  { value: 'audit',    label: 'Audit'    },
  { value: 'test',     label: 'Test'     },
  { value: 'strategy', label: 'Strategy' },
]

const ROLE_DEFAULT_WORKFLOW: Record<RoleId, string> = {
  'RAZ-Dev':  'feature',
  'RAZ-Sec':  'audit',
  'RAZ-QA':   'test',
  'RAZ-Ops':  'strategy',
  'RAZ-Data': 'feature',
}

const ROLE_WORKFLOWS: Record<RoleId, string[]> = {
  'RAZ-Dev':  ['feature', 'fix', 'refactor', 'test', 'strategy'],
  'RAZ-Sec':  ['audit', 'strategy'],
  'RAZ-QA':   ['test', 'fix'],
  'RAZ-Ops':  ['audit', 'strategy'],
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
}

const TYPE_PREFIX: Record<LogEntry['type'], string> = {
  thinking:    '·',
  tool_call:   '▶',
  tool_result: '  ↳',
  plan:        '⊞',
  usage:       '$',
  complete:    '✓',
  error:       '✗',
}

const STATUS_DOT: Record<string, string> = {
  complete: 'bg-green-500',
  failed:   'bg-red-500',
  running:  'bg-yellow-400 animate-pulse',
}

const STATUS_TEXT: Record<string, string> = {
  complete: 'text-green-700',
  failed:   'text-red-600',
  running:  'text-yellow-600',
}

export default function RazDashboard() {
  const [owner,         setOwner]         = useState('')
  const [repos,         setRepos]         = useState<RepoRow[]>([])
  const [selectedRepo,  setSelectedRepo]  = useState<RepoRow | null>(null)
  const [localPath,     setLocalPath]     = useState('')
  const [role,          setRole]          = useState<RoleId>(DEFAULT_ROLE)
  const [workflow,      setWorkflow]      = useState('feature')
  const [issues,        setIssues]        = useState<IssueRow[]>([])
  const [selectedIssue, setSelectedIssue] = useState<IssueRow | null>(null)
  const [syncingIssues, setSyncingIssues] = useState(false)
  const [task,          setTask]          = useState('')
  const [running,       setRunning]       = useState(false)
  const [log,           setLog]           = useState<LogEntry[]>([])
  const [prUrl,         setPrUrl]         = useState<string | null>(null)
  const [tasks,         setTasks]         = useState<TaskRow[]>([])
  const [loadingRepos,  setLoadingRepos]  = useState(true)
  const [activePlan,    setActivePlan]    = useState<string | null>(null)
  const [elapsed,       setElapsed]       = useState(0)
  const [liveCost,      setLiveCost]      = useState<number>(0)
  const [finalCost,     setFinalCost]     = useState<number | null>(null)
  const [selectedTask,  setSelectedTask]  = useState<TaskRow | null>(null)
  const [planOpen,      setPlanOpen]      = useState(false)

  const logRef   = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const startRef = useRef<number>(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    fetch('/api/repos')
      .then((r) => r.json())
      .then(({ owner: o, repos: r }) => { setOwner(o ?? ''); setRepos(r ?? []) })
      .catch(() => {})
      .finally(() => setLoadingRepos(false))
  }, [])

  useEffect(() => {
    if (!selectedRepo) return
    setLocalPath(selectedRepo.local_path ?? '')
    setSelectedIssue(null)
    setIssues([])
    loadTasks(selectedRepo.id)
  }, [selectedRepo])

  useEffect(() => {
    if (workflow === 'fix' && selectedRepo && issues.length === 0) loadIssues(selectedRepo)
  }, [workflow, selectedRepo])

  function loadTasks(repoId: number) {
    fetch(`/api/tasks?repoId=${repoId}`).then((r) => r.json()).then(setTasks).catch(() => {})
  }

  async function loadIssues(repo: RepoRow) {
    const cached = await fetch(`/api/issues?repoId=${repo.id}`).then((r) => r.json()).catch(() => [])
    if (cached.length > 0) { setIssues(cached); return }
    syncIssues(repo)
  }

  async function syncIssues(repo: RepoRow) {
    setSyncingIssues(true)
    try {
      const res = await fetch('/api/issues', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ owner: repo.github_owner, repo: repo.github_repo }),
      })
      const { issues: synced } = await res.json()
      setIssues(synced ?? [])
    } catch {}
    setSyncingIssues(false)
  }

  function appendLog(entry: Omit<LogEntry, 'ts'>) {
    setLog((prev) => [...prev, { ...entry, ts: Date.now() }])
    if (entry.type === 'plan') { setActivePlan(entry.message); setPlanOpen(true) }
    if (entry.type === 'usage') setLiveCost((entry.data?.costUsd as number) ?? 0)
    if (entry.type === 'complete') setFinalCost((entry.data?.costUsd as number) ?? liveCost)
    setTimeout(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }), 50)
  }

  async function saveLocalPath() {
    if (!selectedRepo || !localPath) return
    await fetch('/api/repos', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ owner: selectedRepo.github_owner, repo: selectedRepo.github_repo, localPath }),
    })
    const updated = { ...selectedRepo, local_path: localPath }
    setRepos((prev) => prev.map((r) => r.id === selectedRepo.id ? updated : r))
    setSelectedRepo(updated)
  }

  async function handleRun() {
    if (!selectedRepo || !task.trim()) return
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

    try {
      const res = await fetch('/api/agent', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        signal:  abort.signal,
        body:    JSON.stringify({
          owner:       selectedRepo.github_owner,
          repo:        selectedRepo.github_repo,
          description: task,
          workflow,
          role,
          issueNumber: selectedIssue?.number,
        }),
      })

      if (!res.ok || !res.body) { appendLog({ type: 'error', message: 'Failed to start agent.' }); return }

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
          } catch {}
        }
      }

      if (selectedRepo) loadTasks(selectedRepo.id)
    } catch (e) {
      appendLog({ type: 'error', message: `Connection error: ${e}` })
    } finally {
      if (timerRef.current) clearInterval(timerRef.current)
      setRunning(false)
    }
  }

  const canRun = !running && !!selectedRepo && !!task.trim() && (!!selectedRepo.local_path || !!localPath.trim())
  const activeRole = ROLES[role]

  return (
    <div className="h-screen flex flex-col bg-gray-50 text-gray-900 font-sans overflow-hidden">

      {/* ── Nav ─────────────────────────────────────────────────────────── */}
      <header className="h-11 flex-shrink-0 bg-white border-b border-gray-200 flex items-center justify-between px-4">
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded bg-gray-900 flex items-center justify-center">
            <span className="text-white text-[9px] font-bold tracking-widest">RZ</span>
          </div>
          <span className="text-sm font-semibold text-gray-900">RAZ</span>
          <span className="text-[10px] text-gray-400">Archon Systems · Agent v2</span>
        </div>
        {owner && (
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
            <span className="text-xs text-gray-500">{owner}</span>
          </div>
        )}
      </header>

      {/* ── Body ────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0">

        {/* ── Left panel ──────────────────────────────────────────────── */}
        <div className="w-72 flex-shrink-0 flex flex-col border-r border-gray-200 bg-white overflow-y-auto">
          <div className="flex flex-col gap-3 p-3">

            {/* Repo */}
            <div>
              <label className="block text-[9px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Repository</label>
              {loadingRepos ? (
                <div className="h-8 bg-gray-100 rounded-md animate-pulse" />
              ) : (
                <select
                  value={selectedRepo?.id ?? ''}
                  onChange={(e) => setSelectedRepo(repos.find((r) => r.id === Number(e.target.value)) ?? null)}
                  className="w-full bg-white border border-gray-200 rounded-md px-2.5 py-1.5 text-xs text-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-900"
                >
                  <option value="">Select repository...</option>
                  {repos.map((r) => (
                    <option key={r.id} value={r.id}>{r.github_repo}</option>
                  ))}
                </select>
              )}
              {selectedRepo && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  <span className="text-[9px] bg-gray-100 text-gray-500 rounded-full px-2 py-0.5">
                    {selectedRepo.default_branch}
                  </span>
                  {selectedRepo.local_path
                    ? <span className="text-[9px] bg-gray-100 text-gray-500 rounded-full px-2 py-0.5 font-mono truncate max-w-[200px]">{selectedRepo.local_path}</span>
                    : <span className="text-[9px] bg-amber-50 text-amber-700 rounded-full px-2 py-0.5 border border-amber-200">path not set</span>
                  }
                </div>
              )}
            </div>

            {/* Local path setup (one-time) */}
            {selectedRepo && !selectedRepo.local_path && (
              <div>
                <label className="block text-[9px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Local Path</label>
                <div className="flex gap-1.5">
                  <input
                    value={localPath}
                    onChange={(e) => setLocalPath(e.target.value)}
                    placeholder={`C:\\Projects\\${selectedRepo.github_repo}`}
                    className="flex-1 bg-white border border-gray-200 rounded-md px-2.5 py-1.5 text-[10px] font-mono placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900"
                  />
                  <button onClick={saveLocalPath} className="px-2.5 py-1.5 bg-gray-900 text-white text-[10px] font-medium rounded-md hover:bg-gray-700 transition-colors">
                    Save
                  </button>
                </div>
              </div>
            )}

            {/* Divider */}
            <div className="border-t border-gray-100" />

            {/* Role */}
            <div>
              <label className="block text-[9px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Agent Role</label>
              <div className="flex gap-1">
                {ROLE_IDS.map((r) => {
                  const def    = ROLES[r]
                  const active = role === r
                  return (
                    <button
                      key={r}
                      onClick={() => {
                        setRole(r)
                        setWorkflow((prev) =>
                          ROLE_WORKFLOWS[r].includes(prev) ? prev : ROLE_DEFAULT_WORKFLOW[r]
                        )
                      }}
                      title={def.description}
                      className="flex-1 py-1.5 rounded-md border text-[9px] font-bold tracking-wide transition-all"
                      style={active
                        ? { background: def.color, borderColor: def.color, color: '#fff' }
                        : { background: '#fff', borderColor: '#e5e7eb', color: '#9ca3af' }
                      }
                    >
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
                  <button
                    key={w.value}
                    onClick={() => setWorkflow(w.value)}
                    className={`py-1.5 px-3 rounded-md border text-[10px] font-medium transition-colors ${
                      workflow === w.value
                        ? 'bg-gray-900 text-white border-gray-900'
                        : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'
                    }`}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Issue picker */}
            {workflow === 'fix' && selectedRepo && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest">Linked Issue</label>
                  <button
                    onClick={() => syncIssues(selectedRepo)}
                    disabled={syncingIssues}
                    className="text-[9px] text-blue-600 hover:text-blue-800 disabled:text-gray-400"
                  >
                    {syncingIssues ? 'syncing...' : '↻ sync'}
                  </button>
                </div>
                {issues.length === 0 ? (
                  <p className="text-[10px] text-gray-400">{syncingIssues ? 'Loading...' : 'No open issues.'}</p>
                ) : (
                  <select
                    value={selectedIssue?.id ?? ''}
                    onChange={(e) => setSelectedIssue(issues.find((i) => i.id === Number(e.target.value)) ?? null)}
                    className="w-full bg-white border border-gray-200 rounded-md px-2.5 py-1.5 text-[10px] text-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-900"
                  >
                    <option value="">No issue — describe below</option>
                    {issues.map((i) => (
                      <option key={i.id} value={i.id}>#{i.number} — {i.title}</option>
                    ))}
                  </select>
                )}
              </div>
            )}

            <div className="border-t border-gray-100" />

            {/* Task */}
            <div>
              <label className="block text-[9px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Task</label>
              <textarea
                value={task}
                onChange={(e) => setTask(e.target.value)}
                rows={5}
                placeholder={`What should ${role} do? Be specific — file names, expected behavior, acceptance criteria.`}
                className="w-full bg-gray-50 border border-gray-200 rounded-md px-2.5 py-2 text-xs text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 resize-none leading-relaxed"
              />
            </div>

            {/* Run / Stop */}
            <div className="flex gap-1.5">
              <button
                onClick={handleRun}
                disabled={!canRun}
                className="flex-1 py-2 rounded-md text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-white"
                style={{ background: canRun && !running ? activeRole.color : '#111827' }}
              >
                {running ? (
                  <span className="flex items-center justify-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                    {role} working...
                  </span>
                ) : `Run ${role}`}
              </button>
              {running && (
                <button
                  onClick={() => { abortRef.current?.abort(); setRunning(false) }}
                  className="px-3 py-2 bg-red-600 text-white text-xs font-semibold rounded-md hover:bg-red-700 transition-colors"
                >
                  Stop
                </button>
              )}
            </div>

            {/* Plan (collapsible) */}
            {activePlan && (
              <div className="border border-indigo-200 rounded-md overflow-hidden">
                <button
                  onClick={() => setPlanOpen((v) => !v)}
                  className="w-full flex items-center justify-between px-3 py-2 bg-indigo-50 text-[9px] font-semibold text-indigo-500 uppercase tracking-widest"
                >
                  <span>⊞ {role} Plan</span>
                  <span>{planOpen ? '▲' : '▼'}</span>
                </button>
                {planOpen && (
                  <div className="px-3 py-2 bg-white max-h-48 overflow-y-auto">
                    <pre className="text-[10px] text-gray-700 whitespace-pre-wrap leading-relaxed font-sans">{activePlan}</pre>
                  </div>
                )}
              </div>
            )}

          </div>
        </div>

        {/* ── Right panel ─────────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-h-0">

          {/* Agent Log */}
          <div className="flex-1 flex flex-col min-h-0">
            <div className="h-9 flex-shrink-0 bg-white border-b border-gray-200 flex items-center justify-between px-4">
              <span className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest">Agent Log</span>
              <div className="flex items-center gap-3">
                {prUrl && (
                  <a href={prUrl} target="_blank" rel="noreferrer" className="text-[10px] text-green-700 font-semibold underline underline-offset-2">
                    ✓ View PR ↗
                  </a>
                )}
                {(running || finalCost !== null) && (
                  <span className="text-[10px] font-mono text-gray-400">${(finalCost ?? liveCost).toFixed(4)}</span>
                )}
                {running && (
                  <>
                    <span className="text-[10px] font-mono text-gray-400">
                      {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
                    </span>
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                  </>
                )}
              </div>
            </div>
            <div ref={logRef} className="flex-1 overflow-y-auto p-3 space-y-px bg-gray-50 font-mono text-[10px]">
              {log.length === 0 && !running && (
                <div className="h-full flex items-center justify-center">
                  <span className="text-xs text-gray-300">Select a repo, set a task, and run.</span>
                </div>
              )}
              {log.map((entry, i) => (
                <div key={i} className={`flex gap-2 leading-relaxed ${TYPE_STYLES[entry.type]}`}>
                  <span className="shrink-0 text-[8px] text-gray-300 w-14 text-right pt-px">
                    {new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <span className="shrink-0 w-3 text-center">{TYPE_PREFIX[entry.type]}</span>
                  <span className="break-all">
                    {entry.type === 'tool_call'
                      ? <><span className="font-semibold">{entry.message}</span>{entry.data?.input ? ` — ${JSON.stringify(entry.data.input).slice(0, 120)}` : ''}</>
                      : entry.type === 'plan'
                      ? <span className="text-indigo-500 font-medium">Plan created — see left panel</span>
                      : entry.message}
                  </span>
                </div>
              ))}
              {running && (
                <div className="flex gap-2 text-gray-300 animate-pulse">
                  <span className="w-14 text-right text-[8px]" />
                  <span className="w-3 text-center">·</span>
                  <span>working...</span>
                </div>
              )}
            </div>
          </div>

          {/* Task History */}
          <div className="h-56 flex-shrink-0 border-t border-gray-200 flex flex-col">
            <div className="h-9 flex-shrink-0 bg-white border-b border-gray-200 flex items-center justify-between px-4">
              <span className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest">Task History</span>
              {tasks.length > 0 && (
                <span className="text-[9px] text-gray-400 bg-gray-100 rounded-full px-2 py-0.5">{tasks.length}</span>
              )}
            </div>
            <div className="flex-1 overflow-y-auto bg-white divide-y divide-gray-100">
              {tasks.length === 0 ? (
                <div className="h-full flex items-center justify-center">
                  <span className="text-xs text-gray-300">{selectedRepo ? 'No tasks yet.' : 'Select a repo.'}</span>
                </div>
              ) : tasks.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setSelectedTask(t)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 transition-colors text-left"
                >
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-0.5 ${STATUS_DOT[t.status] ?? 'bg-gray-300'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-[9px] font-bold uppercase tracking-wide ${STATUS_TEXT[t.status] ?? 'text-gray-400'}`}>{t.status}</span>
                      <span className="text-[9px] text-gray-400">{t.role ?? 'RAZ-Dev'} · {t.workflow ?? 'feature'}</span>
                      <span className="text-[9px] text-gray-300 ml-auto">
                        {new Date(t.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <p className="text-[10px] text-gray-600 truncate mt-0.5">{t.description}</p>
                  </div>
                  <span className="text-gray-300 text-[10px] flex-shrink-0">›</span>
                </button>
              ))}
            </div>
          </div>

        </div>
      </div>

      {/* ── Task Detail Modal ──────────────────────────────────────────── */}
      {selectedTask && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ background: 'rgba(0,0,0,0.45)' }}
          onClick={() => setSelectedTask(null)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[82vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-200 flex-shrink-0">
              <div className="flex items-center gap-2.5">
                <span className={`w-2 h-2 rounded-full ${STATUS_DOT[selectedTask.status] ?? 'bg-gray-300'}`} />
                <span className={`text-xs font-bold uppercase tracking-wide ${STATUS_TEXT[selectedTask.status] ?? 'text-gray-500'}`}>{selectedTask.status}</span>
                <span className="text-xs text-gray-400">{selectedTask.role ?? 'RAZ-Dev'} · {selectedTask.workflow ?? 'feature'}</span>
                {selectedTask.issue_number && (
                  <span className="text-xs text-indigo-500">Issue #{selectedTask.issue_number}</span>
                )}
              </div>
              <button onClick={() => setSelectedTask(null)} className="text-gray-400 hover:text-gray-700 text-base leading-none transition-colors">✕</button>
            </div>

            {/* Modal body */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              <div>
                <div className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Task</div>
                <p className="text-sm text-gray-800 leading-relaxed">{selectedTask.description}</p>
              </div>

              {selectedTask.pr_url && (
                <div>
                  <div className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Pull Request</div>
                  <a href={selectedTask.pr_url} target="_blank" rel="noreferrer"
                    className="text-sm text-blue-600 underline underline-offset-2 break-all">
                    {selectedTask.pr_url}
                  </a>
                </div>
              )}

              {selectedTask.summary && (
                <div>
                  <div className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Summary</div>
                  <pre className="text-xs text-gray-700 whitespace-pre-wrap leading-relaxed bg-gray-50 rounded-lg p-3 font-sans border border-gray-100">{selectedTask.summary}</pre>
                </div>
              )}

              {selectedTask.plan && (
                <div>
                  <div className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Plan</div>
                  <pre className="text-xs text-gray-600 whitespace-pre-wrap leading-relaxed bg-gray-50 rounded-lg p-3 font-sans border border-gray-100">{selectedTask.plan}</pre>
                </div>
              )}

              <div className="text-[9px] text-gray-400">
                {new Date(selectedTask.created_at).toLocaleString('en-US', {
                  weekday: 'short', month: 'short', day: 'numeric',
                  hour: '2-digit', minute: '2-digit', second: '2-digit',
                })}
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
