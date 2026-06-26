import { NextRequest, NextResponse } from 'next/server'
import { Octokit } from '@octokit/rest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })

export async function GET(req: NextRequest) {
  const owner = req.nextUrl.searchParams.get('owner')
  const repo  = req.nextUrl.searchParams.get('repo')
  if (!owner || !repo) return NextResponse.json({ error: 'Missing owner or repo' }, { status: 400 })
  try {
    const { data } = await octokit.repos.listBranches({ owner, repo, per_page: 100 })
    return NextResponse.json({ branches: data.map((b) => b.name) })
  } catch (err) {
    return NextResponse.json({ error: `Failed to fetch branches: ${err}` }, { status: 500 })
  }
}
