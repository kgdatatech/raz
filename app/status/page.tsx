'use client'

import React, { useState, useEffect } from 'react'
import Link from 'next/link'

interface RoleStatus {
  role:         string
  total:        number
  complete:     number
  failed:       number
  running:      number
  queued:       number
  success_rate: number
}

interface RecentFailure {
  id:           string
  description:  string
  role:         string
  error:        string | null
  completed_at: string | null
  workflow:     string
}

interface StatusData {
  ts: string
  system: {
    raz_mode:     string
    task_paused:  boolean
    agent_runner: string
  }
  tasks: {
    total:    number
    queued:   number
    running:  number
    complete: number
    failed:   number
    h24: { total: number; complete: number; failed: number; success_rate: number }
    d7:  { total: number; complete: number; failed: number; success_rate: number }
  }
  roles: RoleStatus[]
  prs: {
    open:       number
    merged:     number
    closed:     number
    ci_failing: number
  }
  questions: {
    pending: number
    total:   number
  }
  recent_failures: RecentFailure[]
}

const ROLE_COLORS: Record<string, string> = {
  'RAZ-Dev':  '#6366f1',
  'RAZ-Sec':  '#ef4444',
  'RAZ-QA':   '#22c55e',
  'RAZ-Ops':  '#f59e0b',
  'RAZ-Data': '#a855f7',
}

function rateColor(rate: number): string {
  if (rate >= 80) return '#22c55e'
  if (rate >= 50) return '#f59e0b'
  return '#ef4444'
}

function StatCard({
  label,
  value,
  sub,
  valueColor = 'text-gray-900',
}: {
  label:       string
  value:       string | number
  sub?:        string
  valueColor?: string
}): React.ReactElement {
  return (
    <div className="bg-white rounded-lg border border-gray-200 px-4 py-3 flex flex-col gap-1">
      <span className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest">{label}</span>
      <span className={`text-2xl font-bold tabular-nums ${valueColor}`}>{value}</span>
      {sub && <span className="text-[10px] text-gray-400">{sub}</span>}
    </div>
  )
}

export default function StatusPage(): React.ReactElement {
  const [data,    setData]    = useState<StatusData | null>(null)
  const [healthy, setHealthy] = useState<boolean | null>(null)
  const [lastTs,  setLastTs]  = useState<string | null>(null)
  const [errored, setErrored] = useState(false)

  useEffect(() => {
    const pollStatus = async (): Promise<void> => {
      try {
        const r = await fetch('/api/status')
        const j = await r.json() as StatusData
        setData(j)
        setLastTs(new Date().toLocaleTimeString())
        setErrored(false)
      } catch {
        setErrored(true)
      }
    }

    const pollHealth = async (): Promise<void> => {
      try {
        await fetch('/api/health')
        setHealthy(true)
      } catch {
        setHealthy(false)
      }
    }

    void pollStatus()
    void pollHealth()

    const statusId = setInterval(() => { void pollStatus() }, 10_000)
    const healthId = setInterval(() => { void pollHealth() }, 10_000)

    return () => {
      clearInterval(statusId)
      clearInterval(healthId)
    }
  }, [])

  if (!data) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <span className={`text-sm ${errored ? 'text-red-500' : 'text-gray-400 animate-pulse'}`}>
          {errored ? 'Failed to load status — retrying…' : 'Loading status…'}
        </span>
      </div>
    )
  }

  const { tasks, roles, prs, questions, recent_failures: failures, system } = data

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="h-11 bg-white border-b border-gray-200 flex items-center justify-between px-6">
        <div className="flex items-center gap-2">
          <Link href="/" className="flex items-center gap-2 group">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" className="w-6 h-6 flex-shrink-0">
              <polygon points="56,32 44,11.2 20,11.2 8,32 20,52.8 44,52.8" fill="#818cf8"/>
              <polygon points="50,32 40,15.6 24,15.6 14,32 24,48.4 40,48.4" fill="#0a0a0a"/>
              <polygon points="32,20 44,32 32,44 20,32" fill="#818cf8"/>
              <circle cx="32" cy="32" r="4" fill="#0a0a0a"/>
              <circle cx="32" cy="32" r="2" fill="#818cf8"/>
            </svg>
            <span className="text-base font-bold tracking-tight text-gray-900 group-hover:text-indigo-600 transition-colors" style={{ fontFamily: 'var(--font-display)' }}>RAZ</span>
          </Link>
          <span className="text-[10px] text-gray-300">/</span>
          <span className="text-[10px] font-medium text-gray-600">System Status</span>
        </div>

        <div className="flex items-center gap-3">
          {healthy !== null && (
            <div className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${healthy ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-[10px] text-gray-500">{healthy ? 'API healthy' : 'API unreachable'}</span>
            </div>
          )}
          {lastTs && (
            <span className="text-[9px] text-gray-400">Updated {lastTs}</span>
          )}
          {system.task_paused && (
            <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-amber-500 text-white">⏸ Paused</span>
          )}
          {system.raz_mode !== 'standard' && (
            <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${system.raz_mode === 'autonomous' ? 'bg-violet-600 text-white' : 'bg-amber-500 text-white'}`}>
              {system.raz_mode === 'autonomous' ? '⚡ Autonomous' : '◎ Supervised'}
            </span>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6 flex flex-col gap-6">

        {/* ── Stat cards ─────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <StatCard
            label="Total Tasks"
            value={tasks.total}
          />
          <StatCard
            label="Queue Depth"
            value={tasks.queued}
            valueColor={tasks.queued > 0 ? 'text-violet-600' : 'text-gray-900'}
          />
          <StatCard
            label="Running"
            value={tasks.running}
            valueColor={tasks.running > 0 ? 'text-yellow-500' : 'text-gray-900'}
          />
          <StatCard
            label="24h Success"
            value={tasks.h24.total === 0 ? '—' : `${tasks.h24.success_rate}%`}
            sub={tasks.h24.total > 0 ? `${tasks.h24.complete} ✓  ${tasks.h24.failed} ✗  of ${tasks.h24.total}` : 'no tasks in 24h'}
            valueColor={tasks.h24.total === 0 ? 'text-gray-400' : tasks.h24.success_rate >= 80 ? 'text-green-600' : tasks.h24.success_rate >= 50 ? 'text-amber-500' : 'text-red-600'}
          />
          <StatCard
            label="7d Success"
            value={tasks.d7.total === 0 ? '—' : `${tasks.d7.success_rate}%`}
            sub={tasks.d7.total > 0 ? `${tasks.d7.complete} ✓  ${tasks.d7.failed} ✗  of ${tasks.d7.total}` : 'no tasks in 7d'}
            valueColor={tasks.d7.total === 0 ? 'text-gray-400' : tasks.d7.success_rate >= 80 ? 'text-green-600' : tasks.d7.success_rate >= 50 ? 'text-amber-500' : 'text-red-600'}
          />
        </div>

        {/* ── Per-role table + PR health + Questions ─────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

          {/* Per-role table */}
          <div className="lg:col-span-2 bg-white rounded-lg border border-gray-200 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-gray-100">
              <h2 className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest">Per-Role Success Rates</h2>
            </div>
            {roles.length === 0 ? (
              <div className="px-4 py-8 text-center text-[11px] text-gray-400">No task data yet</div>
            ) : (
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    {(['Role', 'Total', '✓', '✗', 'Running', 'Queued', 'Rate'] as const).map((h) => (
                      <th key={h} className="px-3 py-2 text-left text-[9px] font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-100 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {roles.map((r) => {
                    const color  = ROLE_COLORS[r.role] ?? '#6b7280'
                    const barClr = rateColor(r.success_rate)
                    return (
                      <tr key={r.role} className="hover:bg-gray-50 transition-colors">
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold" style={{ color }}>
                            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: color }} />
                            {r.role}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-700 tabular-nums">{r.total}</td>
                        <td className="px-3 py-2 text-xs text-green-600 tabular-nums">{r.complete}</td>
                        <td className="px-3 py-2 text-xs text-red-500 tabular-nums">{r.failed}</td>
                        <td className="px-3 py-2 text-xs tabular-nums">
                          <span className={r.running > 0 ? 'text-yellow-500' : 'text-gray-300'}>
                            {r.running > 0 ? r.running : '—'}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs tabular-nums">
                          <span className={r.queued > 0 ? 'text-violet-500' : 'text-gray-300'}>
                            {r.queued > 0 ? r.queued : '—'}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          {r.complete + r.failed === 0 ? (
                            <span className="text-[10px] text-gray-300">—</span>
                          ) : (
                            <div className="flex items-center gap-2">
                              <div className="w-14 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                                <div className="h-full rounded-full" style={{ width: `${r.success_rate}%`, background: barClr }} />
                              </div>
                              <span className="text-[10px] font-semibold tabular-nums" style={{ color: barClr }}>
                                {r.success_rate}%
                              </span>
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Right column */}
          <div className="flex flex-col gap-4">

            {/* PR Health */}
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-100">
                <h2 className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest">PR Health</h2>
              </div>
              <div className="px-4 py-3 flex flex-col gap-2.5">
                {([
                  { label: 'Open',       value: prs.open,       cls: 'text-blue-600'   },
                  { label: 'Merged',     value: prs.merged,     cls: 'text-green-600'  },
                  { label: 'Closed',     value: prs.closed,     cls: 'text-gray-500'   },
                  { label: 'CI Failing', value: prs.ci_failing, cls: prs.ci_failing > 0 ? 'text-red-600' : 'text-gray-300' },
                ] as const).map(({ label, value, cls }) => (
                  <div key={label} className="flex justify-between items-center">
                    <span className="text-[10px] text-gray-500">{label}</span>
                    <span className={`text-sm font-bold tabular-nums ${cls}`}>{value}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Agent Questions */}
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-100">
                <h2 className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest">Agent Questions</h2>
              </div>
              <div className="px-4 py-3 flex flex-col gap-2.5">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-gray-500">Pending</span>
                  <span className={`text-sm font-bold tabular-nums ${questions.pending > 0 ? 'text-orange-500' : 'text-gray-300'}`}>
                    {questions.pending}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-gray-500">Total Asked</span>
                  <span className="text-sm font-bold tabular-nums text-gray-700">{questions.total}</span>
                </div>
              </div>
            </div>

            {/* System */}
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-100">
                <h2 className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest">System</h2>
              </div>
              <div className="px-4 py-3 flex flex-col gap-2.5">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-gray-500">Mode</span>
                  <span className={`text-[10px] font-bold uppercase tracking-wide ${system.raz_mode === 'autonomous' ? 'text-violet-600' : system.raz_mode === 'supervised' ? 'text-amber-500' : 'text-gray-700'}`}>
                    {system.raz_mode}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-gray-500">Task Queue</span>
                  <span className={`text-[10px] font-bold ${system.task_paused ? 'text-amber-500' : 'text-green-600'}`}>
                    {system.task_paused ? 'Paused' : 'Active'}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-gray-500">Runner</span>
                  <span className="text-[10px] font-bold text-gray-700">{system.agent_runner}</span>
                </div>
              </div>
            </div>

          </div>
        </div>

        {/* ── Recent Failures ─────────────────────────────────────────────── */}
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-gray-100">
            <h2 className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest">Recent Failures</h2>
          </div>
          {failures.length === 0 ? (
            <div className="px-4 py-6 text-center text-[11px] text-gray-400">No recent failures 🎉</div>
          ) : (
            <div className="divide-y divide-gray-50">
              {failures.map((f) => {
                const color = ROLE_COLORS[f.role] ?? '#6b7280'
                return (
                  <div key={f.id} className="px-4 py-2.5 flex items-start gap-3 hover:bg-gray-50 transition-colors">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500 mt-1.5 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                        <span className="text-[9px] font-semibold" style={{ color }}>{f.role}</span>
                        <span className="text-[9px] text-gray-300">·</span>
                        <span className="text-[9px] text-gray-400">{f.workflow}</span>
                        {f.completed_at && (
                          <>
                            <span className="text-[9px] text-gray-300">·</span>
                            <span className="text-[9px] text-gray-400">
                              {new Date(f.completed_at).toLocaleString()}
                            </span>
                          </>
                        )}
                      </div>
                      <p className="text-[11px] text-gray-700 truncate">{f.description}</p>
                      {f.error && (
                        <p className="text-[10px] text-red-400 mt-0.5 truncate">{f.error}</p>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

      </main>
    </div>
  )
}
