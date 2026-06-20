'use client'

import React, { useEffect, useState, useRef, useCallback } from 'react'

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

const LAYOUTS = {
  compact: {
    W: 720, ROLE_X: 110, REPO_X: 580, PAD_Y: 56,
    ROLE_GAP: 72, REPO_GAP: 54, INACTIVE_GAP: 28,
    ROLE_R: 22, CARD_W: 110, CARD_H: 38,
  },
  wide: {
    W: 1600, ROLE_X: 200, REPO_X: 1340, PAD_Y: 72,
    ROLE_GAP: 110, REPO_GAP: 80, INACTIVE_GAP: 40,
    ROLE_R: 32, CARD_W: 160, CARD_H: 52,
  },
}

export default function BrainView({ onExpand, expandLabel, fullscreen }: { onExpand?: () => void; expandLabel?: string; fullscreen?: boolean } = {}) {
  const [data,    setData]    = useState<BrainData | null>(null)
  const [loading, setLoading] = useState(true)
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef       = useRef<SVGSVGElement>(null)

  const refresh = useCallback(() => {
    setLoading(true)
    fetch('/api/brain').then((r) => r.json()).then(setData).catch(() => {}).finally(() => setLoading(false))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const layout = LAYOUTS[fullscreen ? 'wide' : 'compact']
  const { W, ROLE_X, REPO_X, PAD_Y, ROLE_GAP, REPO_GAP, INACTIVE_GAP, ROLE_R, CARD_W, CARD_H } = layout
  const fs = fullscreen ? 1.45 : 1  // font scale multiplier

  if (loading) return (
    <div className="h-full flex items-center justify-center text-xs text-gray-500 animate-pulse bg-gray-950 rounded-lg">
      Loading brain map...
    </div>
  )
  if (!data) return (
    <div className="h-full flex items-center justify-center text-xs text-gray-500 bg-gray-950 rounded-lg">
      No data available.
    </div>
  )

  // ── Categorise repos ──────────────────────────────────────────────────────
  const activeRepoIds = new Set(data.roleCounts.map((rc) => rc.repo_id))
  const activeRoleIds = new Set(data.roleCounts.map((rc) => rc.role))

  const activeRepos   = data.repos.filter((r) => activeRepoIds.has(r.id))
  const inactiveRepos = data.repos.filter((r) => !activeRepoIds.has(r.id))

  const memMap: Record<number, number>  = {}
  data.memCounts.forEach((m) => { memMap[m.repo_id] = m.count })

  const taskMap: Record<number, { total: number; completed: number }> = {}
  data.tasksByRepo.forEach((t) => { taskMap[t.repo_id] = { total: t.total, completed: t.completed } })

  // ── Dynamic SVG height ────────────────────────────────────────────────────
  const roleSpan     = PAD_Y + (ALL_ROLES.length - 1) * ROLE_GAP + PAD_Y
  const activeSpan   = PAD_Y + Math.max(0, activeRepos.length - 1) * REPO_GAP + CARD_H + 20
  const inactiveSpan = inactiveRepos.length > 0 ? inactiveRepos.length * INACTIVE_GAP + 40 : 0
  const repoSpan     = activeSpan + inactiveSpan
  const SVG_H        = Math.max(roleSpan, repoSpan, 300)

  // ── Positions ─────────────────────────────────────────────────────────────
  const roleCenter = SVG_H / 2
  const roleCY     = roleCenter - ((ALL_ROLES.length - 1) * ROLE_GAP) / 2

  const rolePos: Record<string, { x: number; y: number }> = {}
  ALL_ROLES.forEach((r, i) => { rolePos[r] = { x: ROLE_X, y: roleCY + i * ROLE_GAP } })

  const activeStart = (SVG_H - (activeRepos.length - 1) * REPO_GAP - CARD_H) / 2 + CARD_H / 2
  const repoPos: Record<number, { x: number; y: number }> = {}
  activeRepos.forEach((repo, i) => {
    repoPos[repo.id] = { x: REPO_X, y: Math.max(PAD_Y, activeStart) + i * REPO_GAP }
  })

  const inactiveStartY = activeRepos.length > 0
    ? (repoPos[activeRepos[activeRepos.length - 1]?.id]?.y ?? 0) + CARD_H / 2 + 36
    : PAD_Y
  inactiveRepos.forEach((repo, i) => {
    repoPos[repo.id] = { x: REPO_X, y: inactiveStartY + i * INACTIVE_GAP }
  })

  // ── Edges ────────────────────────────────────────────────────────────────
  const roleRepoEdges = data.roleCounts.map((rc) => ({
    fromRole: rc.role,
    toRepoId: rc.repo_id,
    count:    rc.count,
  }))
  const maxCount = Math.max(...roleRepoEdges.map((e) => e.count), 1)

  function showTip(e: React.MouseEvent, text: string) {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    setTooltip({ x: e.clientX - rect.left + 12, y: e.clientY - rect.top - 28, text })
  }

  const unusedRoles   = ALL_ROLES.filter((r) => !activeRoleIds.has(r))
  const inactiveHalf  = Math.round(CARD_W * 0.47)
  const legendOffsetX = Math.round(CARD_W * 0.79)

  return (
    <div ref={containerRef} className="relative h-full bg-gray-950 rounded-lg overflow-hidden select-none flex flex-col">

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 flex items-center justify-between px-3 py-1.5 border-b border-gray-800/60">
        <div className="flex items-center gap-3">
          {unusedRoles.length > 0 && (
            <span className="text-[8px] text-amber-400 bg-amber-950/60 border border-amber-800/50 rounded px-1.5 py-0.5">
              ⚠ Never used: {unusedRoles.map((r) => r.replace('RAZ-', '')).join(', ')}
            </span>
          )}
          <span className="text-[8px] text-gray-600">
            {roleRepoEdges.length} connections · {activeRepos.length} active repos · {inactiveRepos.length} inactive
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={refresh} className="text-[8px] text-gray-600 hover:text-gray-300 transition-colors px-1.5 py-0.5 rounded hover:bg-gray-800">
            ↻ Refresh
          </button>
          {onExpand && (
            <button onClick={onExpand} className="text-[8px] text-gray-600 hover:text-gray-300 transition-colors px-1.5 py-0.5 rounded hover:bg-gray-800">
              {expandLabel ?? '⛶'}
            </button>
          )}
        </div>
      </div>

      {/* ── SVG area ─────────────────────────────────────────────────────── */}
      <div className={`flex-1 ${fullscreen ? 'overflow-hidden' : 'overflow-y-auto overflow-x-hidden'}`}>
        <svg ref={svgRef} width="100%" height={fullscreen ? '100%' : undefined}
          style={fullscreen ? undefined : { minHeight: SVG_H }}
          viewBox={`0 0 ${W} ${SVG_H}`}
          preserveAspectRatio="xMidYMid meet" onMouseLeave={() => setTooltip(null)}>
          <defs>
            <filter id="glow-brain">
              <feGaussianBlur stdDeviation={fullscreen ? 4 : 2.5} result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>

          {/* ── Role→Repo edges ────────────────────────────────────────── */}
          {roleRepoEdges.map((e, i) => {
            const from = rolePos[e.fromRole]
            const to   = repoPos[e.toRepoId]
            if (!from || !to) return null
            const t     = e.count / maxCount
            const w     = (fullscreen ? 1.5 : 1) + t * 2.5
            const alpha = 0.18 + t * 0.55
            const mx    = from.x + (to.x - from.x) * 0.55
            return (
              <path key={`re-${i}`}
                d={`M ${from.x + ROLE_R} ${from.y} C ${mx} ${from.y}, ${mx} ${to.y}, ${to.x - CARD_W / 2 - 4} ${to.y}`}
                fill="none" stroke={ROLE_COLORS[e.fromRole] ?? '#6366f1'}
                strokeWidth={w} strokeOpacity={alpha}
                style={{ cursor: 'crosshair' }}
                onMouseMove={(ev) => showTip(ev, `${e.fromRole} → ${data.repos.find((r) => r.id === e.toRepoId)?.github_repo}: ${e.count} task${e.count !== 1 ? 's' : ''}`)}
              />
            )
          })}

          {/* ── Role→Role edges ────────────────────────────────────────── */}
          {data.roleConnections.map((e, i) => {
            const from   = rolePos[e.from_role]
            const to     = rolePos[e.to_role]
            if (!from || !to || e.from_role === e.to_role) return null
            const isDel  = e.message_type === 'delegation'
            const color  = isDel ? '#a855f7' : '#22c55e'
            const curveX = from.x - (fullscreen ? 90 : 55) - (i % 3) * (fullscreen ? 22 : 14)
            return (
              <path key={`rr-${i}`}
                d={`M ${from.x - ROLE_R} ${from.y} Q ${curveX} ${(from.y + to.y) / 2}, ${to.x - ROLE_R} ${to.y}`}
                fill="none" stroke={color} strokeWidth={fullscreen ? 2 : 1.5} strokeOpacity={0.55} strokeDasharray="5 3"
                style={{ cursor: 'crosshair' }}
                onMouseMove={(ev) => showTip(ev, `${e.from_role} → ${e.to_role}: ${e.count} ${e.message_type}${e.count !== 1 ? 's' : ''}`)}
              />
            )
          })}

          {/* ── Role nodes ─────────────────────────────────────────────── */}
          {ALL_ROLES.map((role) => {
            const pos    = rolePos[role]
            const color  = ROLE_COLORS[role]
            const active = activeRoleIds.has(role)
            return (
              <g key={role} opacity={active ? 1 : 0.28} style={{ cursor: 'default' }}
                onMouseMove={(ev) => showTip(ev, active ? role : `${role} — no tasks yet`)}>
                <circle cx={pos.x} cy={pos.y} r={ROLE_R + (fullscreen ? 10 : 6)} fill={color} fillOpacity={0.07} stroke="none" />
                <circle cx={pos.x} cy={pos.y} r={ROLE_R} fill={color} fillOpacity={0.13}
                  stroke={color} strokeWidth={fullscreen ? 2 : 1.5} filter={active ? 'url(#glow-brain)' : undefined} />
                {active && <circle cx={pos.x} cy={pos.y} r={fullscreen ? 7 : 5} fill={color} />}
                <text x={pos.x} y={pos.y - ROLE_R - (fullscreen ? 12 : 8)} textAnchor="middle"
                  fill={active ? color : '#4b5563'} fontSize={Math.round(9 * fs)} fontWeight={700} fontFamily="ui-monospace, monospace">
                  {role.replace('RAZ-', '')}
                </text>
              </g>
            )
          })}

          {/* ── Active repo cards ──────────────────────────────────────── */}
          {activeRepos.map((repo) => {
            const pos   = repoPos[repo.id]
            const mem   = memMap[repo.id] ?? 0
            const tasks = taskMap[repo.id]
            const pct   = tasks && tasks.total > 0 ? tasks.completed / tasks.total : 0
            const name  = repo.github_repo
            const maxCh = fullscreen ? 18 : 13
            return (
              <g key={repo.id} style={{ cursor: 'default' }}
                onMouseMove={(ev) => showTip(ev, `${name} · ${tasks?.total ?? 0} tasks (${tasks?.completed ?? 0} done) · ${mem} memory entries`)}>
                <rect x={pos.x - CARD_W / 2} y={pos.y - CARD_H / 2} width={CARD_W} height={CARD_H} rx={fullscreen ? 10 : 7}
                  fill="#1a2235" stroke="#2d3f5c" strokeWidth={1.2} />
                {tasks && tasks.total > 0 && (
                  <>
                    <rect x={pos.x - CARD_W / 2 + 6} y={pos.y + CARD_H / 2 - 9} width={CARD_W - 12} height={4} rx={2} fill="#0f172a" />
                    <rect x={pos.x - CARD_W / 2 + 6} y={pos.y + CARD_H / 2 - 9} width={(CARD_W - 12) * pct} height={4} rx={2} fill="#6366f1" />
                  </>
                )}
                <text x={pos.x} y={pos.y - (fullscreen ? 8 : 5)} textAnchor="middle"
                  fill="#cbd5e1" fontSize={Math.round(9.5 * fs)} fontWeight={700} fontFamily="ui-monospace, monospace">
                  {name.length > maxCh ? name.slice(0, maxCh - 1) + '…' : name}
                </text>
                <text x={pos.x} y={pos.y + (fullscreen ? 12 : 9)} textAnchor="middle" fill="#475569" fontSize={Math.round(7.5 * fs)} fontFamily="sans-serif">
                  {tasks ? `${tasks.completed}/${tasks.total} done` : '—'} · {mem} mem
                </text>
              </g>
            )
          })}

          {/* ── Inactive repos: compact dots ───────────────────────────── */}
          {inactiveRepos.length > 0 && (
            <>
              <text x={REPO_X} y={inactiveStartY - 14} textAnchor="middle"
                fill="#374151" fontSize={Math.round(7.5 * fs)} fontFamily="sans-serif" fontStyle="italic">
                {inactiveRepos.length} inactive repos
              </text>
              {inactiveRepos.map((repo) => {
                const pos = repoPos[repo.id]
                return (
                  <g key={repo.id} opacity={0.4} style={{ cursor: 'default' }}
                    onMouseMove={(ev) => showTip(ev, `${repo.github_repo} — no tasks yet`)}>
                    <rect x={pos.x - inactiveHalf} y={pos.y - 9} width={inactiveHalf * 2} height={18} rx={4}
                      fill="#111827" stroke="#1f2937" strokeWidth={1} />
                    <text x={pos.x} y={pos.y + 4} textAnchor="middle"
                      fill="#4b5563" fontSize={Math.round(8 * fs)} fontFamily="ui-monospace, monospace">
                      {repo.github_repo.length > 16 ? repo.github_repo.slice(0, 15) + '…' : repo.github_repo}
                    </text>
                  </g>
                )
              })}
            </>
          )}

          {/* ── Legend ─────────────────────────────────────────────────── */}
          <g transform={`translate(${W - 8}, 12)`}>
            {ALL_ROLES.map((r, i) => (
              <g key={r} transform={`translate(0, ${i * (fullscreen ? 22 : 16)})`}>
                <circle cx={-legendOffsetX} cy={6} r={fullscreen ? 6 : 4} fill={ROLE_COLORS[r]} />
                <text x={-legendOffsetX + 10} y={10} fill="#6b7280" fontSize={Math.round(8 * fs)} fontFamily="sans-serif">{r}</text>
              </g>
            ))}
            <g transform={`translate(0, ${ALL_ROLES.length * (fullscreen ? 22 : 16) + 6})`}>
              <line x1={-legendOffsetX - 4} y1={6} x2={-legendOffsetX + 10} y2={6} stroke="#6366f1" strokeWidth={2} strokeOpacity={0.6} />
              <text x={-legendOffsetX + 13} y={10} fill="#6b7280" fontSize={Math.round(8 * fs)} fontFamily="sans-serif">task link</text>
            </g>
            <g transform={`translate(0, ${ALL_ROLES.length * (fullscreen ? 22 : 16) + (fullscreen ? 30 : 22)})`}>
              <line x1={-legendOffsetX - 4} y1={6} x2={-legendOffsetX + 10} y2={6} stroke="#a855f7" strokeWidth={1.5} strokeDasharray="4 2" strokeOpacity={0.7} />
              <text x={-legendOffsetX + 13} y={10} fill="#6b7280" fontSize={Math.round(8 * fs)} fontFamily="sans-serif">delegation</text>
            </g>
            <g transform={`translate(0, ${ALL_ROLES.length * (fullscreen ? 22 : 16) + (fullscreen ? 54 : 38)})`}>
              <line x1={-legendOffsetX - 4} y1={6} x2={-legendOffsetX + 10} y2={6} stroke="#22c55e" strokeWidth={1.5} strokeDasharray="4 2" strokeOpacity={0.7} />
              <text x={-legendOffsetX + 13} y={10} fill="#6b7280" fontSize={Math.round(8 * fs)} fontFamily="sans-serif">handoff</text>
            </g>
          </g>
        </svg>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div className="absolute pointer-events-none bg-gray-800/95 text-gray-100 text-[9px] px-2 py-1 rounded shadow-xl border border-gray-600/60 z-20 whitespace-nowrap"
          style={{ left: Math.min(tooltip.x, 500), top: Math.max(0, tooltip.y) }}>
          {tooltip.text}
        </div>
      )}
    </div>
  )
}
