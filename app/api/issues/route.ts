import { NextRequest, NextResponse } from 'next/server'
import { getRepo, listIssues } from '@/lib/db'
import { syncAndQueueIssues } from '@/lib/issue-pipeline'

export const dynamic = 'force-dynamic'

// GET ?repoId=N[&state=open|closed|all] — list issues from local DB
export async function GET(req: NextRequest) {
  const repoId = req.nextUrl.searchParams.get('repoId')
  const state  = req.nextUrl.searchParams.get('state') ?? 'open'
  if (!repoId) return NextResponse.json({ error: 'repoId required' }, { status: 400 })
  return NextResponse.json(listIssues(Number(repoId), state))
}

// POST { owner, repo } — sync open issues from GitHub and queue a task for each new one
export async function POST(req: NextRequest) {
  const body = await req.json() as { owner?: string; repo?: string }
  const { owner, repo } = body
  if (!owner || !repo) return NextResponse.json({ error: 'owner and repo required' }, { status: 400 })

  const repoRow = getRepo(owner, repo)
  if (!repoRow) return NextResponse.json({ error: 'Repo not found in DB. Load the repos list first.' }, { status: 404 })

  try {
    const result = await syncAndQueueIssues(repoRow)
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: `Issue pipeline failed: ${e}` }, { status: 500 })
  }
}
