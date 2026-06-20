import { NextResponse } from 'next/server'
import db from '@/lib/db'

export const runtime = 'nodejs'

export async function GET() {
  const repos = db.prepare('SELECT id, github_owner, github_repo FROM repos').all() as { id: number; github_owner: string; github_repo: string }[]

  const roleCounts = db.prepare(`
    SELECT role, repo_id, COUNT(*) as count FROM tasks
    WHERE role IS NOT NULL AND repo_id IS NOT NULL
    GROUP BY role, repo_id
  `).all() as { role: string; repo_id: number; count: number }[]

  const memCounts = db.prepare(`
    SELECT repo_id, COUNT(*) as count FROM memory GROUP BY repo_id
  `).all() as { repo_id: number; count: number }[]

  const roleConnections = db.prepare(`
    SELECT from_role, to_role, message_type, COUNT(*) as count FROM agent_messages
    GROUP BY from_role, to_role, message_type
  `).all() as { from_role: string; to_role: string; message_type: string; count: number }[]

  const tasksByRepo = db.prepare(`
    SELECT repo_id, COUNT(*) as total, SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) as completed
    FROM tasks GROUP BY repo_id
  `).all() as { repo_id: number; total: number; completed: number }[]

  return NextResponse.json({
    repos,
    roleCounts,
    memCounts,
    roleConnections,
    tasksByRepo,
  })
}
