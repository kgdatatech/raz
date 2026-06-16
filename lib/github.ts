import { Octokit } from '@octokit/rest'
import { execSync } from 'child_process'

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })

export interface PROptions {
  repoPath:    string
  owner:       string
  repo:        string
  branch:      string
  baseBranch:  string
  title:       string
  body:        string
}

export async function pushBranchAndOpenPR(opts: PROptions): Promise<string> {
  const { repoPath, owner, repo, branch, baseBranch, title, body } = opts

  // Push the worktree branch to origin
  execSync(`git push origin "${branch}"`, { cwd: repoPath })

  const pr = await octokit.pulls.create({
    owner,
    repo,
    title,
    body,
    head:  branch,
    base:  baseBranch,
    draft: false,
  })

  return pr.data.html_url
}

export async function getRepoInfo(owner: string, repo: string) {
  const { data } = await octokit.repos.get({ owner, repo })
  return {
    defaultBranch: data.default_branch,
    fullName:      data.full_name,
    private:       data.private,
  }
}
