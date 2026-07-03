'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { ROLE_IDS, ROLES, type RoleId } from '@/lib/roles'
import { MODEL_IDS, SUPPORTED_MODELS } from '@/lib/model-catalog'

interface SpendState {
  today_usd:     number
  daily_cap_usd: number
  task_cap_usd:  number
  cap_reached:   boolean
}

interface RunnerState {
  active_tasks:         number
  max_concurrent_tasks: number
}

function modelLabel(id: string): string {
  const p = SUPPORTED_MODELS[id]
  return p ? `${id}  ($${p.inputPerM}/$${p.outputPerM})` : id
}

async function postConfig(key: string, value: string): Promise<string | null> {
  try {
    const res = await fetch('/api/config', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ key, value }),
    })
    if (res.ok) return null
    const body = await res.json().catch(() => ({ error: 'Save failed.' }))
    return typeof body.error === 'string' ? body.error : 'Save failed.'
  } catch {
    return 'Could not reach the server.'
  }
}

export default function SettingsPanel({ onClose }: { onClose: () => void }): React.ReactElement {
  const [models,   setModels]   = useState<Record<string, string>>({})   // config key → model id
  const [dailyCap, setDailyCap] = useState('')
  const [taskCap,  setTaskCap]  = useState('')
  const [maxConc,  setMaxConc]  = useState('')
  const [spend,    setSpend]    = useState<SpendState | null>(null)
  const [runner,   setRunner]   = useState<RunnerState | null>(null)
  const [error,    setError]    = useState<string | null>(null)
  const [loaded,   setLoaded]   = useState(false)

  const load = useCallback(async () => {
    try {
      const [cfgRes, statusRes] = await Promise.all([fetch('/api/config'), fetch('/api/status')])
      const cfg    = await cfgRes.json()
      const status = await statusRes.json()
      const picked: Record<string, string> = {}
      for (const key of Object.keys(cfg)) {
        if (key === 'agent_model' || key.startsWith('agent_model_')) picked[key] = String(cfg[key])
      }
      setModels(picked)
      setDailyCap(String(cfg.spend_daily_cap_usd ?? '10'))
      setTaskCap(String(cfg.spend_task_cap_usd ?? '2'))
      setMaxConc(String(cfg.max_concurrent_tasks ?? '2'))
      if (status?.spend)  setSpend(status.spend as SpendState)
      if (status?.runner) setRunner(status.runner as RunnerState)
    } catch {
      setError('Could not load settings.')
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function changeModel(configKey: string, value: string) {
    setError(null)
    const previous = { ...models }
    if (value === 'default') {
      const next = { ...models }
      delete next[configKey]
      setModels(next)
    } else {
      setModels({ ...models, [configKey]: value })
    }
    const err = await postConfig(configKey, value)
    if (err) { setError(err); setModels(previous) }
  }

  async function saveNumber(key: string, value: string) {
    setError(null)
    const err = await postConfig(key, value.trim())
    if (err) setError(err)
    else void load()
  }

  function ModelSelect({ configKey, unsetLabel }: { configKey: string; unsetLabel: string }) {
    return (
      <select
        value={models[configKey] ?? 'default'}
        onChange={(e) => void changeModel(configKey, e.target.value)}
        className="flex-1 min-w-0 bg-white border border-gray-200 rounded px-1.5 py-1 text-[9px] font-mono text-gray-700 focus:outline-none focus:ring-1 focus:ring-indigo-400"
      >
        <option value="default">{unsetLabel}</option>
        {MODEL_IDS.map((id) => <option key={id} value={id}>{modelLabel(id)}</option>)}
      </select>
    )
  }

  return (
    <div className="absolute right-0 top-9 z-50 w-80 bg-white border border-gray-200 rounded-lg shadow-xl p-3 flex flex-col gap-3 text-left">
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest">Settings</span>
        <button onClick={onClose} className="text-[10px] text-gray-400 hover:text-gray-700 transition-colors">✕</button>
      </div>

      {!loaded ? (
        <p className="text-[10px] text-gray-400 animate-pulse">Loading…</p>
      ) : (
        <>
          {/* Models */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest">Models</span>
            <div className="flex items-center gap-2">
              <span className="w-16 flex-shrink-0 text-[9px] font-medium text-gray-500">All roles</span>
              <ModelSelect configKey="agent_model" unsetLabel="runner default" />
            </div>
            {ROLE_IDS.map((r: RoleId) => (
              <div key={r} className="flex items-center gap-2">
                <span className="w-16 flex-shrink-0 text-[9px] font-semibold" style={{ color: ROLES[r].color }}>{ROLES[r].badge}</span>
                <ModelSelect configKey={`agent_model_${r}`} unsetLabel="↳ all roles" />
              </div>
            ))}
            <p className="text-[8px] text-gray-400">
              SDK runner default: claude-sonnet-4-6. Claude Code runner: your CLI /model default unless set here.
            </p>
          </div>

          {/* Spend caps */}
          <div className="flex flex-col gap-1.5 border-t border-gray-100 pt-2.5">
            <span className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest">Spend caps</span>
            <div className="flex items-center gap-2">
              <span className="w-16 flex-shrink-0 text-[9px] font-medium text-gray-500">Daily $</span>
              <input value={dailyCap} onChange={(e) => setDailyCap(e.target.value)}
                onBlur={() => void saveNumber('spend_daily_cap_usd', dailyCap)}
                className="w-16 bg-white border border-gray-200 rounded px-1.5 py-1 text-[9px] font-mono focus:outline-none focus:ring-1 focus:ring-indigo-400" />
              {spend && (
                <span className={`text-[9px] ${spend.cap_reached ? 'text-red-600 font-semibold' : 'text-gray-400'}`}>
                  today ${spend.today_usd.toFixed(2)}{spend.cap_reached ? ' — cap reached, queue paused' : ''}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="w-16 flex-shrink-0 text-[9px] font-medium text-gray-500">Per-task $</span>
              <input value={taskCap} onChange={(e) => setTaskCap(e.target.value)}
                onBlur={() => void saveNumber('spend_task_cap_usd', taskCap)}
                className="w-16 bg-white border border-gray-200 rounded px-1.5 py-1 text-[9px] font-mono focus:outline-none focus:ring-1 focus:ring-indigo-400" />
              <span className="text-[9px] text-gray-400">0 disables a cap</span>
            </div>
          </div>

          {/* Concurrency */}
          <div className="flex flex-col gap-1.5 border-t border-gray-100 pt-2.5">
            <span className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest">Concurrency</span>
            <div className="flex items-center gap-2">
              <span className="w-16 flex-shrink-0 text-[9px] font-medium text-gray-500">Max tasks</span>
              <input value={maxConc} onChange={(e) => setMaxConc(e.target.value)}
                onBlur={() => void saveNumber('max_concurrent_tasks', maxConc)}
                className="w-16 bg-white border border-gray-200 rounded px-1.5 py-1 text-[9px] font-mono focus:outline-none focus:ring-1 focus:ring-indigo-400" />
              <span className="text-[9px] text-gray-400">
                1–8{runner ? ` · ${runner.active_tasks} running now` : ''}
              </span>
            </div>
          </div>

          {error && <p className="text-[9px] text-red-600 border-t border-gray-100 pt-2">{error}</p>}
        </>
      )}
    </div>
  )
}
