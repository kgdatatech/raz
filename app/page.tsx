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
  { value: 'feature',  label: 'Feature',  desc: 'Build new functionality' },
  { value: 'fix',      label: 'Fix',      desc: 'Debug and resolve an issue' },
  { value: 'refactor', label: 'Refactor', desc: 'Improve code without changing behavior' },
  { value: 'audit',    label: 'Audit',    desc: 'Security and code quality review' },
  { value: 'test',     label: 'Test',     desc: 'Write or improve tests' },
  { value: 'strategy', label: 'Strategy', desc: 'Research and plan — no code changes' },
]

const ROLE_DEFAULT_WORKFLOW: Record<RoleId, string> = {
  'RAZ-Dev':  'feature',
  'RAZ-Sec':  'audit',
  'RAZ-QA':   'test',
  'RAZ-Ops':  'strategy',
  'RAZ-Data': 'feature',
}

const TYPE_STYLES: Record<LogEntry['type'], string> = {
  thinking:    'text-gray-500',
  tool_call:   'text-blue-600',
  tool_result: 'text-gray-400',
  plan:        'text-indigo-600',
  usage:       'text-gray-300',
  complete:    'text-green-700',
  error:       'text-red-600',
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

function TaskCard({ task: t }: { task: TaskRow }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="p-4 space-y-2">
        <div className="flex items-center gap-2">
          <div className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[t.status] ?? 'bg-gray-300'}`} />
          <span className={`text-[10px] font-bold uppercase tracking-wider ${STATUS_TEXT[t.status] ?? 'text-gray-400'}`}>{t.status}</span>
          <span className="text-[10px] text-gray-300 ml-auto">{t.role ? `${t.role} · ` : ''}{t.workflow ?? 'feature'}</span>
        </div>
        <p className="text-xs text-gray-700 leading-snug">{t.description}</p>
        {t.issue_number && <span className="text-[10px] text-indigo-500">Issue #{t.issue_number}</span>}
        {t.pr_url && (
          <a href={t.pr_url} target="_blank" rel="noreferrer" className="text-[11px] text-blue-600 hover:text-blue-800 underline underline-offset-2 block truncate">
            View Pull Request
          </a>
        )}
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-gray-300">{new Date(t.created_at).toLocaleString()}</span>
          {t.summary && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-[11px] text-gray-400 hover:text-gray-700 transition-colors"
            >
              {expanded ? 'collapse ↑' : 'read report ↓'}
            </button>
          )}
        </div>
      </div>
      {expanded && t.summary && (
        <div className="border-t border-gray-100 bg-gray-50 px-4 py-4">
          <pre className="text-xs text-gray-700 whitespace-pre-wrap leading-relaxed font-sans">{t.summary}</pre>
        </div>
      )}
    </div>
  )
}

export default function RazielDashboard() {
  const [owner,        setOwner]        = useState('')
  const [repos,        setRepos]        = useState<RepoRow[]>([])
  const [selectedRepo, setSelectedRepo] = useState<RepoRow | null>(null)
  const [localPath,    setLocalPath]    = useState('')
  const [role,         setRole]         = useState<RoleId>(DEFAULT_ROLE)
  const [workflow,     setWorkflow]     = useState('feature')
  const [issues,       setIssues]       = useState<IssueRow[]>([])
  const [selectedIssue, setSelectedIssue] = useState<IssueRow | null>(null)
  const [syncingIssues, setSyncingIssues] = useState(false)
  const [task,         setTask]         = useState('')
  const [running,      setRunning]      = useState(false)
  const [log,          setLog]          = useState<LogEntry[]>([])
  const [prUrl,        setPrUrl]        = useState<string | null>(null)
  const [tasks,        setTasks]        = useState<TaskRow[]>([])
  const [loadingRepos, setLoadingRepos] = useState(true)
  const [activePlan,   setActivePlan]   = useState<string | null>(null)
  const [elapsed,      setElapsed]      = useState(0)
  const [liveCost,     setLiveCost]     = useState<number>(0)
  const [finalCost,    setFinalCost]    = useState<number | null>(null)
  const logRef    = useRef<HTMLDivElement>(null)
  const abortRef  = useRef<AbortController | null>(null)
  const startRef  = useRef<number>(0)
  const timerRef  = useRef<ReturnType<typeof setInterval> | null>(null)

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

  // Auto-sync issues when fix workflow selected and repo chosen
  useEffect(() => {
    if (workflow === 'fix' && selectedRepo && issues.length === 0) {
      loadIssues(selectedRepo)
    }
  }, [workflow, selectedRepo])

  function loadTasks(repoId: number) {
    fetch(`/api/tasks?repoId=${repoId}`).then((r) => r.json()).then(setTasks).catch(() => {})
  }

  async function loadIssues(repo: RepoRow) {
    // Try local DB first
    const cached = await fetch(`/api/issues?repoId=${repo.id}`).then((r) => r.json()).catch(() => [])
    if (cached.length > 0) { setIssues(cached); return }
    // Sync from GitHub
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
    if (entry.type === 'plan') setActivePlan(entry.message)
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

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans">

      {/* Nav */}
      <header className="bg-white border-b border-gray-200 px-8 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded bg-gray-900 flex items-center justify-center">
            <span className="text-white text-[10px] font-bold tracking-widest">RZ</span>
          </div>
          <div>
            <div className="text-sm font-semibold text-gray-900 leading-none">RAZ</div>
            <div className="text-[10px] text-gray-400 mt-0.5">Archon Systems · Agent v2</div>
          </div>
        </div>
        {owner && (
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-green-500" />
            <span className="text-xs text-gray-500">{owner}</span>
          </div>
        )}
      </header>

      <main className="max-w-6xl mx-auto px-8 py-10">
        <div className="grid grid-cols-3 gap-8">
          <div className="col-span-2 space-y-5">

            {/* Repo + Workflow */}
            <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest">Target</h2>

              {/* Repo */}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1.5">Repository</label>
                {loadingRepos ? (
                  <div className="text-sm text-gray-400 animate-pulse">Connecting to GitHub...</div>
                ) : (
                  <select
                    value={selectedRepo?.id ?? ''}
                    onChange={(e) => setSelectedRepo(repos.find((r) => r.id === Number(e.target.value)) ?? null)}
                    className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2.5 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-900"
                  >
                    <option value="">Select a repository...</option>
                    {repos.map((r) => (
                      <option key={r.id} value={r.id}>{r.github_repo}</option>
                    ))}
                  </select>
                )}
              </div>

              {/* Repo meta */}
              {selectedRepo && (
                <div className="flex flex-wrap gap-2">
                  <span className="inline-flex items-center gap-1 bg-gray-100 text-gray-500 text-[11px] rounded-full px-3 py-1">
                    <span className="text-gray-400">branch</span> {selectedRepo.default_branch}
                  </span>
                  {selectedRepo.local_path
                    ? <span className="inline-flex items-center bg-gray-100 text-gray-500 text-[11px] rounded-full px-3 py-1 font-mono">{selectedRepo.local_path}</span>
                    : <span className="inline-flex items-center bg-amber-50 text-amber-700 text-[11px] rounded-full px-3 py-1 border border-amber-200">local path not set</span>
                  }
                </div>
              )}

              {/* One-time local path */}
              {selectedRepo && !selectedRepo.local_path && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1.5">
                    Local path <span className="text-gray-400 font-normal">(one-time setup)</span>
                  </label>
                  <div className="flex gap-2">
                    <input
                      value={localPath}
                      onChange={(e) => setLocalPath(e.target.value)}
                      placeholder={`C:\\Users\\keanu\\Projects\\${selectedRepo.github_repo}`}
                      className="flex-1 bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900"
                    />
                    <button onClick={saveLocalPath} className="px-4 py-2 bg-gray-900 text-white text-xs font-medium rounded-lg hover:bg-gray-700 transition-colors">
                      Save
                    </button>
                  </div>
                </div>
              )}

              {/* Role */}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-2">Agent Role</label>
                <div className="grid grid-cols-5 gap-2">
                  {ROLE_IDS.map((r) => {
                    const def = ROLES[r]
                    const active = role === r
                    return (
                      <button
                        key={r}
                        onClick={() => { setRole(r); setWorkflow(ROLE_DEFAULT_WORKFLOW[r]) }}
                        className={`text-left px-3 py-2.5 rounded-lg border text-xs transition-colors ${
                          active ? 'border-transparent text-white' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
                        }`}
                        style={active ? { background: def.color, borderColor: def.color } : {}}
                      >
                        <div className="font-bold tracking-wide">{def.badge}</div>
                        <div className={`text-[10px] mt-0.5 ${active ? 'text-white/80' : 'text-gray-400'}`}>{def.description.split('.')[0]}</div>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Workflow */}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-2">Workflow</label>
                <div className="grid grid-cols-3 gap-2">
                  {WORKFLOWS.map((w) => (
                    <button
                      key={w.value}
                      onClick={() => setWorkflow(w.value)}
                      className={`text-left px-3 py-2.5 rounded-lg border text-xs transition-colors ${
                        workflow === w.value
                          ? 'bg-gray-900 text-white border-gray-900'
                          : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
                      }`}
                    >
                      <div className="font-semibold">{w.label}</div>
                      <div className={`text-[10px] mt-0.5 ${workflow === w.value ? 'text-gray-300' : 'text-gray-400'}`}>{w.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Issue picker — shown when fix workflow */}
              {workflow === 'fix' && selectedRepo && (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-medium text-gray-700">Linked Issue <span className="text-gray-400 font-normal">(optional)</span></label>
                    <button
                      onClick={() => syncIssues(selectedRepo)}
                      disabled={syncingIssues}
                      className="text-[11px] text-blue-600 hover:text-blue-800 disabled:text-gray-400"
                    >
                      {syncingIssues ? 'syncing...' : 'sync from GitHub'}
                    </button>
                  </div>
                  {issues.length === 0 ? (
                    <div className="text-xs text-gray-400">{syncingIssues ? 'Loading issues...' : 'No open issues found.'}</div>
                  ) : (
                    <select
                      value={selectedIssue?.id ?? ''}
                      onChange={(e) => setSelectedIssue(issues.find((i) => i.id === Number(e.target.value)) ?? null)}
                      className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-900"
                    >
                      <option value="">No issue — describe the fix below</option>
                      {issues.map((i) => (
                        <option key={i.id} value={i.id}>#{i.number} — {i.title}</option>
                      ))}
                    </select>
                  )}
                </div>
              )}
            </div>

            {/* Task */}
            <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest">Task</h2>
              <textarea
                value={task}
                onChange={(e) => setTask(e.target.value)}
                rows={5}
                placeholder={`Describe exactly what ${role} should do. Be specific — include file names, expected behavior, acceptance criteria, and any relevant context.`}
                className="w-full bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 resize-none leading-relaxed"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleRun}
                  disabled={!canRun}
                  className="flex-1 py-3 bg-gray-900 text-white font-semibold text-sm rounded-lg hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {running ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                      {role} is working...
                    </span>
                  ) : `Run ${role}`}
                </button>
                {running && (
                  <button
                    onClick={() => { abortRef.current?.abort(); setRunning(false) }}
                    className="px-5 py-3 bg-red-600 text-white font-semibold text-sm rounded-lg hover:bg-red-700 transition-colors"
                  >
                    Stop
                  </button>
                )}
              </div>
            </div>

            {/* Plan panel — appears when Raziel creates a plan */}
            {activePlan && (
              <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-5">
                <div className="text-xs font-semibold text-indigo-500 uppercase tracking-widest mb-3">{role} Plan</div>
                <pre className="text-xs text-indigo-900 whitespace-pre-wrap leading-relaxed font-sans">{activePlan}</pre>
              </div>
            )}

            {/* PR Banner */}
            {prUrl && (
              <div className="bg-green-50 border border-green-200 rounded-xl px-5 py-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-green-500" />
                  <span className="text-sm font-semibold text-green-800">Pull request ready for review</span>
                </div>
                <a href={prUrl} target="_blank" rel="noreferrer" className="text-sm text-green-700 underline underline-offset-2 ml-4">
                  View PR
                </a>
              </div>
            )}

            {/* Agent Log */}
            {log.length > 0 && (
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-500 uppercase tracking-widest">Agent Log</span>
                  <div className="flex items-center gap-3">
                    {(running || finalCost !== null) && (
                      <span className="text-[11px] font-mono text-gray-400">
                        ${(finalCost ?? liveCost).toFixed(4)}
                      </span>
                    )}
                    {running && (
                      <>
                        <span className="text-[11px] text-gray-400 font-mono">
                          {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
                        </span>
                        <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                      </>
                    )}
                  </div>
                </div>
                <div ref={logRef} className="p-4 h-80 overflow-y-auto space-y-1 bg-gray-50 font-mono text-xs">
                  {log.map((entry, i) => (
                    <div key={i} className={`flex gap-2 ${TYPE_STYLES[entry.type]}`}>
                      <span className="shrink-0 text-[9px] text-gray-300 w-12 text-right leading-relaxed pt-px">
                        {new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                      <span className="shrink-0 w-3 text-center">{TYPE_PREFIX[entry.type]}</span>
                      <span className="break-all leading-relaxed">
                        {entry.type === 'tool_call'
                          ? <><span className="font-semibold">{entry.message}</span>{entry.data?.input ? ` — ${JSON.stringify(entry.data.input).slice(0, 100)}` : ''}</>
                          : entry.type === 'plan'
                          ? <span className="text-indigo-600 font-medium">Plan created — see panel above</span>
                          : entry.message}
                      </span>
                    </div>
                  ))}
                  {running && (
                    <div className="flex gap-2 text-gray-400 animate-pulse">
                      <span className="w-4 text-right">·</span>
                      <span>working...</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Task History Sidebar */}
          <div>
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-4">Task History</h2>
            {tasks.length === 0 ? (
              <div className="bg-white rounded-xl border border-gray-200 p-5 text-sm text-gray-400">
                {selectedRepo ? 'No tasks yet.' : 'Select a repo.'}
              </div>
            ) : (
              <div className="space-y-3">
                {tasks.map((t) => (
                  <TaskCard key={t.id} task={t} />
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
