import { vi, describe, it, expect, beforeEach } from 'vitest'

const octokitMocks = vi.hoisted(() => ({
  pullsCreate: vi.fn(),
  pullsList:   vi.fn(),
}))

vi.mock('@octokit/rest', () => ({
  Octokit: class {
    pulls = {
      create: octokitMocks.pullsCreate,
      list:   octokitMocks.pullsList,
    }
  },
}))

vi.mock('child_process', () => ({ execSync: vi.fn() }))

import { pushBranchAndOpenPR } from '@/lib/github'
import { execSync } from 'child_process'

const OPTS = {
  repoPath:   '/tmp/repo',
  owner:      'owner',
  repo:       'repo',
  branch:     'raz-dev/feature-x',
  baseBranch: 'master',
  title:      'PR title',
  body:       'PR body',
}

describe('pushBranchAndOpenPR()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('pushes the branch and returns the new PR url', async () => {
    octokitMocks.pullsCreate.mockResolvedValue({ data: { html_url: 'https://github.com/owner/repo/pull/7' } })
    const url = await pushBranchAndOpenPR(OPTS)
    expect(url).toBe('https://github.com/owner/repo/pull/7')
    expect(execSync).toHaveBeenCalledWith('git push origin "raz-dev/feature-x"', expect.objectContaining({ cwd: '/tmp/repo' }))
    expect(octokitMocks.pullsList).not.toHaveBeenCalled()
  })

  it('returns the existing PR url when a PR is already open for the branch', async () => {
    octokitMocks.pullsCreate.mockRejectedValue(
      Object.assign(new Error('A pull request already exists for owner:raz-dev/feature-x.'), { status: 422 }),
    )
    octokitMocks.pullsList.mockResolvedValue({ data: [{ html_url: 'https://github.com/owner/repo/pull/42' }] })

    const url = await pushBranchAndOpenPR(OPTS)

    expect(url).toBe('https://github.com/owner/repo/pull/42')
    expect(octokitMocks.pullsList).toHaveBeenCalledWith({
      owner: 'owner', repo: 'repo', head: 'owner:raz-dev/feature-x', state: 'open',
    })
  })

  it('rethrows the original error when creation fails and no PR exists for the branch', async () => {
    octokitMocks.pullsCreate.mockRejectedValue(new Error('Validation Failed: base branch not found'))
    octokitMocks.pullsList.mockResolvedValue({ data: [] })

    await expect(pushBranchAndOpenPR(OPTS)).rejects.toThrow('base branch not found')
  })
})
