import { NextRequest, NextResponse } from 'next/server'
import { Octokit } from '@octokit/rest'
import { upsertRepo, updateRepoLocalPath, listRepos } from '@/lib/db'

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })

// GET — list repos (from GitHub, cached in local DB)
export async function GET() {
  try {
    // Fetch authenticated user's repos from GitHub
    const { data: ghRepos } = await octokit.repos.listForAuthenticatedUser({
      per_page: 100,
      sort:     'updated',
      type:     'owner',
    })

    // Upsert each into local DB
    for (const r of ghRepos) {
      upsertRepo(r.owner.login, r.name, r.default_branch)
    }

    // Return DB rows (includes local_path if previously set)
    const repos = listRepos()
    const { data: user } = await octokit.users.getAuthenticated()

    return NextResponse.json({ owner: user.login, repos })
  } catch (err) {
    return NextResponse.json({ error: `Failed to fetch repos: ${err}` }, { status: 500 })
  }
}

// PATCH — set local path for a repo
export async function PATCH(req: NextRequest) {
  const { owner, repo, localPath } = await req.json()
  if (!owner || !repo || !localPath) {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
  }
  updateRepoLocalPath(owner, repo, localPath)
  return NextResponse.json({ ok: true })
}
