'use client'

import React, { useState, useEffect } from 'react'

interface RoleMetric {
  role:     string
  complete: number
  failed:   number
  running:  number
  queued:   number
  total:    number
}

interface WindowMetric {
  complete: number
  failed:   number
  total:    number
}

interface PrHealthMetric {
  merged:      number
  openPassing: number
  openFailing: number
  openPending: number
}

interface RecentFailure {
  id:          string
  description: string
  role:        string | null
  error:       string | null
  completedAt: string | null
}

interface StatusData {
  running:          number
  queued:           number
  pendingQuestions: number
  config:           Record<string, string>
  byRole:           RoleMetric[]
  last24h:          WindowMetric
  last7d:           WindowMetric
  prHealth:         PrHealthMetric
  recentFailures:   RecentFailure[]
  generatedAt:      string
}

const ROLE_COLORS: Record<string, string> = {
  'RAZ-Dev':  '#6366f1',
  'RAZ-Sec':  '#ef4444',
  'RAZ-QA':   '#22c55e',
  'RAZ-Ops':  '#f59e0b',
  'RAZ-Data': '#a855f7',
}

const ROLE_BADGES: Record<string, string> = {
  'RAZ-Dev':  'DEV',
  'RAZ-Sec':  'SEC',
  'RAZ-QA':   'QA',
  'RAZ-Ops':  'OPS',
  'RAZ-Data': 'DATA',
}

function successRate(m: RoleMetric): number {
  const settled = m.complete + m.failed
  return settled === 0 ? 0 : Math.round((m.complete / settled) * 100)
}

function windowRate(w: WindowMetric): number {
  const settled = w.complete + w.failed
  return settled === 0 ? 0 : Math.round((w.complete / settled) * 100)
}

function timeAgo(iso: string | null): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60)  return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60)  return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)  return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function HealthBar({ rate, label, w }: { rate: number; label: string; w: WindowMetric }) {
  const color = rate >= 80 ? '#22c55e' : rate >= 50 ? '#f59e0b' : '#ef4444'
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[9px] font-semibold text-gray-500 uppercase tracking-widest">{label}</span>
        <span className="text-[10px] font-bold" style={{ color }}>{rate}%</span>
      </div>
      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${rate}%`, backgroundColor: color }} />
      </div>
      <div className="flex justify-between mt-1">
        <span className="text-[9px] text-gray-400">{w.complete} complete · {w.failed} failed</span>
        <span className="text-[9px] text-gray-400">{w.total} total</span>
      </div>
    </div>
  )
}

export default function StatusPage(): React.ReactElement {
  const [data,        setData]        = useState<StatusData | null>(null)
  const [fetchError,  setFetchError]  = useState(false)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [secsAgo,     setSecsAgo]     = useState(0)

  useEffect(() => {
    const poll = async (): Promise<void> => {
      try {
        const r = await fetch('/api/status')
        const j = await r.json() as StatusData
        setData(j)
        setLastUpdated(Date.now())
        setFetchError(false)
      } catch {
        setFetchError(true)
      }
    }
    void poll()
    const id = setInterval(() => { void poll() }, 10_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!lastUpdated) return
    const id = setInterval(() => {
      setSecsAgo(Math.floor((Date.now() - lastUpdated) / 1000))
    }, 1000)
    return () => clearInterval(id)
  }, [lastUpdated])

  const mode = data?.config['raz_mode'] ?? 'standard'
  const paused = data?.config['task_paused'] === '1'

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans">

      {/* Header */}
      <header className="h-11 bg-white border-b border-gray-200 flex items-center justify-between px-4">
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
          <span className="text-[10px] text-gray-400">System Status</span>
        </div>
        <div className="flex items-center gap-3">
          {fetchError ? (
            <span className="flex items-center gap-1.5 text-[9px] font-semibold text-red-600">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
              Connection error
            </span>
          ) : lastUpdated ? (
            <span className="flex items-center gap-1.5 text-[9px] text-gray-400">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
              Live · updated {secsAgo}s ago
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-[9px] text-gray-400">
              <span className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-pulse" />
              Loading...
            </span>
          )}
          <a href="/" className="text-[9px] font-semibold text-gray-400 hover:text-gray-700 transition-colors">
            ← Dashboard
          </a>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-5">

        {/* Summary cards */}
        <div className="grid grid-cols-4 gap-3">
          {[
            {
              label: 'Running',
              value: data?.running ?? '—',
              dot:   data?.running ? 'bg-yellow-400 animate-pulse' : 'bg-gray-200',
              text:  data?.running ? 'text-yellow-600' : 'text-gray-400',
            },
            {
              label: 'Queued',
              value: data?.queued ?? '—',
              dot:   data?.queued ? 'bg-violet-400' : 'bg-gray-200',
              text:  data?.queued ? 'text-violet-600' : 'text-gray-400',
            },
            {
              label: 'Pending Questions',
              value: data?.pendingQuestions ?? '—',
              dot:   data?.pendingQuestions ? 'bg-orange-400 animate-pulse' : 'bg-gray-200',
              text:  data?.pendingQuestions ? 'text-orange-600' : 'text-gray-400',
            },
            {
              label: 'Mode',
              value: paused ? 'Paused' : mode.charAt(0).toUpperCase() + mode.slice(1),
              dot:   paused ? 'bg-amber-400' : mode === 'autonomous' ? 'bg-violet-500' : mode === 'supervised' ? 'bg-amber-400' : 'bg-green-500',
              text:  paused ? 'text-amber-600' : mode === 'autonomous' ? 'text-violet-600' : mode === 'supervised' ? 'text-amber-600' : 'text-green-600',
            },
          ].map(({ label, value, dot, text }) => (
            <div key={label} className="bg-white rounded-lg border border-gray-200 px-4 py-3">
              <div className="flex items-center gap-1.5 mb-1.5">
                <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot}`} />
                <span className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest">{label}</span>
              </div>
              <div className={`text-xl font-bold ${text}`}>{value}</div>
            </div>
          ))}
        </div>

        {/* Health windows + Per-role table */}
        <div className="grid grid-cols-3 gap-3">

          {/* 24h + 7d health */}
          <div className="col-span-1 bg-white rounded-lg border border-gray-200 px-4 py-3 space-y-4">
            <div className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest">Health Windows</div>
            {data ? (
              <>
                <HealthBar rate={windowRate(data.last24h)} label="Last 24 h" w={data.last24h} />
                <HealthBar rate={windowRate(data.last7d)}  label="Last 7 d"  w={data.last7d}  />
              </>
            ) : (
              <div className="space-y-3">
                <div className="h-10 bg-gray-100 rounded animate-pulse" />
                <div className="h-10 bg-gray-100 rounded animate-pulse" />
              </div>
            )}
          </div>

          {/* Per-role success rates */}
          <div className="col-span-2 bg-white rounded-lg border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100">
              <span className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest">Per-Role Success Rates</span>
            </div>
            {data && data.byRole.length > 0 ? (
              <table className="w-full text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    {['Role', 'Total', '✓ Complete', '✗ Failed', 'Rate', 'Active'].map((h) => (
                      <th key={h} className="px-3 py-2 text-left text-[9px] font-semibold text-gray-400 uppercase tracking-wide whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.byRole.map((m) => {
                    const rate = successRate(m)
                    const color = rate >= 80 ? '#22c55e' : rate >= 50 ? '#f59e0b' : '#ef4444'
                    const badge = ROLE_BADGES[m.role] ?? m.role
                    const roleColor = ROLE_COLORS[m.role] ?? '#6b7280'
                    return (
                      <tr key={m.role} className="hover:bg-gray-50 transition-colors">
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded text-white"
                            style={{ backgroundColor: roleColor }}>
                            {badge}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-[10px] font-semibold text-gray-700">{m.total}</td>
                        <td className="px-3 py-2 text-[10px] text-green-600 font-medium">{m.complete}</td>
                        <td className="px-3 py-2 text-[10px] text-red-500 font-medium">{m.failed}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1.5">
                            <div className="w-12 h-1 bg-gray-100 rounded-full overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${rate}%`, backgroundColor: color }} />
                            </div>
                            <span className="text-[10px] font-bold" style={{ color }}>
                              {m.complete + m.failed === 0 ? '—' : `${rate}%`}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-[10px] text-gray-400">
                          {m.running > 0 && <span className="text-yellow-500 font-medium">{m.running} running</span>}
                          {m.running > 0 && m.queued > 0 && ' · '}
                          {m.queued  > 0 && <span className="text-violet-500 font-medium">{m.queued} queued</span>}
                          {m.running === 0 && m.queued === 0 && '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            ) : data ? (
              <div className="px-4 py-6 text-[10px] text-gray-400 text-center">No task history yet.</div>
            ) : (
              <div className="p-4 space-y-2">
                {[1, 2, 3].map((i) => <div key={i} className="h-8 bg-gray-100 rounded animate-pulse" />)}
              </div>
            )}
          </div>
        </div>

        {/* PR Health */}
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
          <div className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest mb-3">PR Health</div>
          {data ? (
            <div className="flex flex-wrap gap-4">
              {[
                { label: 'Merged',       value: data.prHealth.merged,      dot: 'bg-violet-400', text: 'text-violet-600' },
                { label: 'Open · CI ✓',  value: data.prHealth.openPassing, dot: 'bg-green-400',  text: 'text-green-600'  },
                { label: 'Open · CI ✗',  value: data.prHealth.openFailing, dot: 'bg-red-400',    text: 'text-red-600'    },
                { label: 'Open · Pending', value: data.prHealth.openPending, dot: 'bg-gray-300', text: 'text-gray-500'  },
              ].map(({ label, value, dot, text }) => (
                <div key={label} className="flex items-center gap-2 min-w-[100px]">
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
                  <div>
                    <div className={`text-base font-bold ${text}`}>{value}</div>
                    <div className="text-[9px] text-gray-400">{label}</div>
                  </div>
                </div>
              ))}
              {data.prHealth.merged + data.prHealth.openPassing + data.prHealth.openFailing + data.prHealth.openPending === 0 && (
                <span className="text-[10px] text-gray-400">No PR data recorded yet.</span>
              )}
            </div>
          ) : (
            <div className="flex gap-4">
              {[1, 2, 3, 4].map((i) => <div key={i} className="w-24 h-10 bg-gray-100 rounded animate-pulse" />)}
            </div>
          )}
        </div>

        {/* Recent Failures */}
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <span className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest">Recent Failures</span>
            {data && data.recentFailures.length > 0 && (
              <span className="text-[9px] text-gray-400">{data.recentFailures.length} shown</span>
            )}
          </div>
          {data ? (
            data.recentFailures.length > 0 ? (
              <div className="divide-y divide-gray-100">
                {data.recentFailures.map((f) => {
                  const badge  = ROLE_BADGES[f.role ?? ''] ?? (f.role ?? 'DEV')
                  const roleColor = ROLE_COLORS[f.role ?? ''] ?? '#6b7280'
                  return (
                    <div key={f.id} className="flex items-start gap-3 px-4 py-2.5 hover:bg-gray-50 transition-colors">
                      <span className="text-red-500 text-[10px] font-bold flex-shrink-0 mt-0.5">✗</span>
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded text-white flex-shrink-0 mt-0.5"
                        style={{ backgroundColor: roleColor }}>
                        {badge}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-[10px] text-gray-800 truncate">{f.description}</div>
                        {f.error && (
                          <div className="text-[9px] text-red-400 font-mono truncate mt-0.5">{f.error}</div>
                        )}
                      </div>
                      <span className="text-[9px] text-gray-400 flex-shrink-0 mt-0.5">{timeAgo(f.completedAt)}</span>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="px-4 py-6 text-[10px] text-gray-400 text-center">No failures recorded.</div>
            )
          ) : (
            <div className="p-4 space-y-2">
              {[1, 2, 3].map((i) => <div key={i} className="h-8 bg-gray-100 rounded animate-pulse" />)}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="text-center text-[9px] text-gray-400 pb-4">
          {lastUpdated
            ? `Updated ${secsAgo}s ago · auto-refreshes every 10s`
            : 'Connecting...'}
        </div>
      </main>
    </div>
  )
}
