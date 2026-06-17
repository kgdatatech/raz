import { NextRequest, NextResponse } from 'next/server'
import { syncIssues } from '@/lib/github'
import { getRepo, upsertIssue, listIssues } from '@/lib/db'

// GET ?repoId=N — list issues from local DB
export async function GET(req: NextRequest) {
  const repoId = req.nextUrl.searchParams.get('repoId')
  const state  = req.nextUrl.searchParams.get('state') ?? 'open'
  if (!repoId) return NextResponse.json({ error: 'repoId required' }, { status: 400 })
  return NextResponse.json(listIssues(Number(repoId), state))
}

// POST { owner, repo } — sync from GitHub then return
export async function POST(req: NextRequest) {
  const { owner, repo } = await req.json()
  if (!owner || !repo) return NextResponse.json({ error: 'owner and repo required' }, { status: 400 })

  const repoRow = getRepo(owner, repo)
  if (!repoRow) return NextResponse.json({ error: 'Repo not found in DB. Load the repos list first.' }, { status: 404 })

  try {
    const issues = await syncIssues(owner, repo)
    for (const issue of issues) {
      upsertIssue(repoRow.id, issue)
    }
    return NextResponse.json({ synced: issues.length, issues: listIssues(repoRow.id, 'open') })
  } catch (e) {
    return NextResponse.json({ error: `GitHub sync failed: ${e}` }, { status: 500 })
  }
}
