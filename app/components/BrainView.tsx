'use client'

import React, { useEffect, useState, useRef } from 'react'

interface BrainData {
  repos:           { id: number; github_owner: string; github_repo: string }[]
  roleCounts:      { role: string; repo_id: number; count: number }[]
  memCounts:       { repo_id: number; count: number }[]
  roleConnections: { from_role: string; to_role: string; message_type: string; count: number }[]
  tasksByRepo:     { repo_id: number; total: number; completed: number }[]
}

const ROLE_COLORS: Record<string, string> = {
  'RAZ-Dev':  '#6366f1',
  'RAZ-Sec':  '#ef4444',
  'RAZ-QA':   '#22c55e',
  'RAZ-Ops':  '#a855f7',
  'RAZ-Data': '#f59e0b',
}

const ALL_ROLES = ['RAZ-Dev', 'RAZ-Sec', 'RAZ-QA', 'RAZ-Ops', 'RAZ-Data']

const W = 680
const H = 380

export default function BrainView() {
  const [data,    setData]    = useState<BrainData | null>(null)
  const [loading, setLoading] = useState(true)
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    fetch('/api/brain').then((r) => r.json()).then(setData).catch(() => {}).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="h-full flex items-center justify-center text-xs text-gray-400 animate-pulse">Loading brain map...</div>
  if (!data)   return <div className="h-full flex items-center justify-center text-xs text-gray-400">No data available.</div>

  // ── Layout ──────────────────────────────────────────────────────────────────
  const roleX  = 120
  const repoX  = W - 120
  const padY   = 60
  const roleH  = (H - padY * 2) / Math.max(ALL_ROLES.length - 1, 1)
  const repoH  = data.repos.length > 1 ? (H - padY * 2) / (data.repos.length - 1) : 0

  const rolePos: Record<string, { x: number; y: number }> = {}
  ALL_ROLES.forEach((r, i) => { rolePos[r] = { x: roleX, y: padY + i * roleH } })

  const repoPos: Record<number, { x: number; y: number }> = {}
  data.repos.forEach((repo, i) => {
    repoPos[repo.id] = { x: repoX, y: data.repos.length === 1 ? H / 2 : padY + i * repoH }
  })

  // active role → repo edges
  const roleRepoEdges = data.roleCounts.map((rc) => ({
    fromRole: rc.role,
    toRepoId: rc.repo_id,
    count:    rc.count,
  }))

  // which roles/repos are connected
  const activeRoles = new Set(data.roleCounts.map((rc) => rc.role))
  const activeRepos = new Set(data.roleCounts.map((rc) => rc.repo_id))

  // role → role connections
  const roleRoleEdges = data.roleConnections

  const memMap: Record<number, number> = {}
  data.memCounts.forEach((m) => { memMap[m.repo_id] = m.count })

  const taskMap: Record<number, { total: number; completed: number }> = {}
  data.tasksByRepo.forEach((t) => { taskMap[t.repo_id] = { total: t.total, completed: t.completed } })

  const maxCount = Math.max(...roleRepoEdges.map((e) => e.count), 1)

  function showTooltip(e: React.MouseEvent, text: string) {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    setTooltip({ x: e.clientX - rect.left + 10, y: e.clientY - rect.top - 10, text })
  }

  return (
    <div className="relative h-full bg-gray-950 rounded-lg overflow-hidden select-none">
      {/* Legend */}
      <div className="absolute top-2 right-3 flex flex-col gap-1 z-10">
        <div className="text-[8px] font-semibold text-gray-500 uppercase tracking-widest mb-0.5">Legend</div>
        {ALL_ROLES.map((r) => (
          <div key={r} className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full" style={{ background: ROLE_COLORS[r] }} />
            <span className="text-[8px] text-gray-400">{r}</span>
          </div>
        ))}
        <div className="mt-1 flex items-center gap-1.5">
          <div className="w-4 h-0.5 bg-blue-400 opacity-60" />
          <span className="text-[8px] text-gray-400">task link</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-0.5 bg-violet-400 opacity-60" style={{ borderTop: '1px dashed' }} />
          <span className="text-[8px] text-gray-400">delegation</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-0.5 bg-green-400 opacity-60" style={{ borderTop: '1px dashed' }} />
          <span className="text-[8px] text-gray-400">handoff</span>
        </div>
      </div>

      {/* Gaps label */}
      {ALL_ROLES.filter((r) => !activeRoles.has(r)).length > 0 && (
        <div className="absolute top-2 left-3 text-[8px] text-amber-500 bg-amber-950/60 rounded px-1.5 py-0.5 border border-amber-800/40 z-10">
          ⚠ {ALL_ROLES.filter((r) => !activeRoles.has(r)).join(', ')} — never used
        </div>
      )}

      <svg ref={svgRef} width="100%" height="100%" viewBox={`0 0 ${W} ${H}`}
        onMouseLeave={() => setTooltip(null)}>
        <defs>
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* ── Role → Repo edges ─────────────────────────────────── */}
        {roleRepoEdges.map((e, i) => {
          const from = rolePos[e.fromRole]
          const to   = repoPos[e.toRepoId]
          if (!from || !to) return null
          const t     = e.count / maxCount
          const width = 1 + t * 3
          const alpha = 0.2 + t * 0.6
          const mx    = (from.x + to.x) / 2
          return (
            <path key={i}
              d={`M ${from.x + 22} ${from.y} C ${mx} ${from.y}, ${mx} ${to.y}, ${to.x - 20} ${to.y}`}
              fill="none"
              stroke="#6366f1"
              strokeWidth={width}
              strokeOpacity={alpha}
              onMouseMove={(ev) => showTooltip(ev, `${e.fromRole} → ${data.repos.find((r) => r.id === e.toRepoId)?.github_repo}: ${e.count} task${e.count !== 1 ? 's' : ''}`)}
            />
          )
        })}

        {/* ── Role → Role edges ─────────────────────────────────── */}
        {roleRoleEdges.map((e, i) => {
          const from = rolePos[e.from_role]
          const to   = rolePos[e.to_role]
          if (!from || !to || from === to) return null
          const isDelegation = e.message_type === 'delegation'
          const color = isDelegation ? '#a855f7' : '#22c55e'
          const off   = (i % 3) * 20 - 20
          return (
            <path key={`rr-${i}`}
              d={`M ${from.x} ${from.y + 8} Q ${from.x - 60 + off} ${(from.y + to.y) / 2}, ${to.x} ${to.y - 8}`}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              strokeOpacity={0.5}
              strokeDasharray="5 3"
              onMouseMove={(ev) => showTooltip(ev, `${e.from_role} → ${e.to_role}: ${e.count} ${e.message_type}${e.count !== 1 ? 's' : ''}`)}
            />
          )
        })}

        {/* ── Role nodes ────────────────────────────────────────── */}
        {ALL_ROLES.map((role) => {
          const pos     = rolePos[role]
          const color   = ROLE_COLORS[role]
          const active  = activeRoles.has(role)
          const opacity = active ? 1 : 0.3
          return (
            <g key={role} opacity={opacity}
              onMouseMove={(ev) => showTooltip(ev, `${role}${active ? '' : ' — no tasks yet'}`)}
              style={{ cursor: 'default' }}>
              <circle cx={pos.x} cy={pos.y} r={20} fill={color} fillOpacity={0.15} stroke={color} strokeWidth={1.5}
                filter={active ? 'url(#glow)' : undefined} />
              {active && <circle cx={pos.x} cy={pos.y} r={4} fill={color} />}
              <text x={pos.x} y={pos.y - 26} textAnchor="middle" fill={active ? color : '#6b7280'}
                fontSize={8} fontWeight={600} fontFamily="ui-monospace, monospace">
                {role.replace('RAZ-', '')}
              </text>
            </g>
          )
        })}

        {/* ── Repo nodes ────────────────────────────────────────── */}
        {data.repos.map((repo) => {
          const pos     = repoPos[repo.id]
          const active  = activeRepos.has(repo.id)
          const mem     = memMap[repo.id] ?? 0
          const tasks   = taskMap[repo.id]
          const opacity = active ? 1 : 0.35
          return (
            <g key={repo.id} opacity={opacity}
              onMouseMove={(ev) => showTooltip(ev, `${repo.github_repo} · ${tasks?.total ?? 0} tasks · ${mem} memory entries`)}
              style={{ cursor: 'default' }}>
              <rect x={pos.x - 38} y={pos.y - 16} width={76} height={32} rx={6}
                fill={active ? '#1e293b' : '#111827'} stroke={active ? '#334155' : '#1f2937'} strokeWidth={1} />
              <text x={pos.x} y={pos.y - 3} textAnchor="middle" fill={active ? '#e2e8f0' : '#4b5563'}
                fontSize={8.5} fontWeight={600} fontFamily="ui-monospace, monospace">
                {repo.github_repo.slice(0, 12)}
              </text>
              <text x={pos.x} y={pos.y + 9} textAnchor="middle" fill={active ? '#64748b' : '#374151'} fontSize={7} fontFamily="sans-serif">
                {tasks ? `${tasks.completed}/${tasks.total} done` : 'no tasks'} · {mem}mem
              </text>
            </g>
          )
        })}

        {/* Center label */}
        <text x={W / 2} y={H - 10} textAnchor="middle" fill="#1f2937" fontSize={9} fontFamily="sans-serif">
          {roleRepoEdges.length} active connections · {data.repos.length} repos · {ALL_ROLES.filter((r) => !activeRoles.has(r)).length} unused roles
        </text>
      </svg>

      {/* Tooltip */}
      {tooltip && (
        <div className="absolute pointer-events-none bg-gray-800 text-gray-100 text-[9px] px-2 py-1 rounded shadow-lg border border-gray-700 z-20 whitespace-nowrap"
          style={{ left: tooltip.x, top: tooltip.y }}>
          {tooltip.text}
        </div>
      )}
    </div>
  )
}
