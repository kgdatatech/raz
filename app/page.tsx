'use client'

import { useState, useRef } from 'react'

interface LogEntry {
  type:    'thinking' | 'tool_call' | 'tool_result' | 'complete' | 'error'
  message: string
  data?:   Record<string, unknown>
  ts:      number
}

const TYPE_STYLES: Record<LogEntry['type'], string> = {
  thinking:    'text-zinc-400',
  tool_call:   'text-blue-400',
  tool_result: 'text-zinc-500',
  complete:    'text-green-400',
  error:       'text-red-400',
}

const TYPE_PREFIX: Record<LogEntry['type'], string> = {
  thinking:    '·',
  tool_call:   '▶',
  tool_result: '  ↳',
  complete:    '✓',
  error:       '✗',
}

export default function RazielDashboard() {
  const [repoPath,   setRepoPath]   = useState('')
  const [owner,      setOwner]      = useState('')
  const [repo,       setRepo]       = useState('')
  const [baseBranch, setBaseBranch] = useState('master')
  const [task,       setTask]       = useState('')
  const [running,    setRunning]    = useState(false)
  const [log,        setLog]        = useState<LogEntry[]>([])
  const [prUrl,      setPrUrl]      = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  function appendLog(entry: Omit<LogEntry, 'ts'>) {
    setLog((prev) => [...prev, { ...entry, ts: Date.now() }])
    setTimeout(() => {
      logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
    }, 50)
  }

  async function handleRun() {
    if (!repoPath || !owner || !repo || !task) return
    setRunning(true)
    setLog([])
    setPrUrl(null)

    try {
      const res = await fetch('/api/agent', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ repoPath, owner, repo, baseBranch, description: task }),
      })

      if (!res.ok || !res.body) {
        appendLog({ type: 'error', message: 'Failed to start agent.' })
        return
      }

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
            if (event.type === 'complete' && event.data?.prUrl) {
              setPrUrl(event.data.prUrl as string)
            }
          } catch {}
        }
      }
    } catch (e) {
      appendLog({ type: 'error', message: `Connection error: ${e}` })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-100 font-mono p-8">
      <div className="max-w-4xl mx-auto space-y-8">

        {/* Header */}
        <div>
          <div className="text-[10px] tracking-[0.3em] text-zinc-600 uppercase mb-1">Archon Systems</div>
          <h1 className="text-2xl font-bold text-white tracking-tight">RAZIEL</h1>
          <div className="text-xs text-zinc-500 mt-1">Intelligence & Research Agent · Phase 1</div>
        </div>

        {/* Config */}
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="block text-[10px] tracking-widest text-zinc-500 uppercase mb-1.5">Local Repo Path</label>
            <input
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="C:\Users\keanu\Projects\kairos"
              className="w-full bg-[#111] border border-[#222] rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-700 focus:outline-none focus:border-zinc-600"
            />
          </div>
          <div>
            <label className="block text-[10px] tracking-widest text-zinc-500 uppercase mb-1.5">GitHub Owner</label>
            <input
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder="kgdatatech"
              className="w-full bg-[#111] border border-[#222] rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-700 focus:outline-none focus:border-zinc-600"
            />
          </div>
          <div>
            <label className="block text-[10px] tracking-widest text-zinc-500 uppercase mb-1.5">GitHub Repo</label>
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="kairos"
              className="w-full bg-[#111] border border-[#222] rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-700 focus:outline-none focus:border-zinc-600"
            />
          </div>
          <div>
            <label className="block text-[10px] tracking-widest text-zinc-500 uppercase mb-1.5">Base Branch</label>
            <input
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              placeholder="master"
              className="w-full bg-[#111] border border-[#222] rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-700 focus:outline-none focus:border-zinc-600"
            />
          </div>
        </div>

        {/* Task */}
        <div>
          <label className="block text-[10px] tracking-widest text-zinc-500 uppercase mb-1.5">Task Description</label>
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            rows={4}
            placeholder="Describe exactly what you want Raziel to build or fix..."
            className="w-full bg-[#111] border border-[#222] rounded px-3 py-2.5 text-sm text-zinc-200 placeholder-zinc-700 focus:outline-none focus:border-zinc-600 resize-none"
          />
        </div>

        {/* Run */}
        <button
          onClick={handleRun}
          disabled={running || !repoPath || !owner || !repo || !task}
          className="w-full py-3 bg-white text-black font-bold text-sm tracking-widest uppercase rounded hover:bg-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          {running ? 'RAZIEL IS WORKING...' : 'DEPLOY RAZIEL'}
        </button>

        {/* PR Link */}
        {prUrl && (
          <div className="border border-green-900/40 bg-green-950/20 rounded px-4 py-3 flex items-center justify-between">
            <span className="text-green-400 text-sm font-bold">PR Ready for Review</span>
            <a href={prUrl} target="_blank" rel="noreferrer" className="text-green-300 text-xs underline underline-offset-2">
              {prUrl}
            </a>
          </div>
        )}

        {/* Log */}
        {log.length > 0 && (
          <div>
            <div className="text-[10px] tracking-widest text-zinc-600 uppercase mb-2">Agent Log</div>
            <div
              ref={logRef}
              className="bg-[#0d0d0d] border border-[#1a1a1a] rounded p-4 h-96 overflow-y-auto space-y-1 text-xs"
            >
              {log.map((entry, i) => (
                <div key={i} className={`flex gap-2 ${TYPE_STYLES[entry.type]}`}>
                  <span className="shrink-0 w-4 text-right">{TYPE_PREFIX[entry.type]}</span>
                  <span className="break-all leading-relaxed">
                    {entry.type === 'tool_call' ? (
                      <><span className="text-blue-300">{entry.message}</span>{entry.data?.input ? ` — ${JSON.stringify(entry.data.input).slice(0, 120)}` : ''}</>
                    ) : entry.message}
                  </span>
                </div>
              ))}
              {running && (
                <div className="flex gap-2 text-zinc-600 animate-pulse">
                  <span className="w-4 text-right">·</span>
                  <span>thinking...</span>
                </div>
              )}
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
