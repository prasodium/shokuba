import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EvidencePack } from '../evidence/types'
import { missionBranch } from '../git/refs'
import { GitService } from '../git/service'
import { createMissionFixture, type MissionFixture } from '../missions/fixtures'
import { removeTree, toPlatformId } from '../platform'
import { GitHubClient } from './client'
import { GhCli } from './gh'
import { PullRequestService, type PullRequestServiceDeps } from './pulls'
import { GitHubService } from './service'
import { fakeGh, type FakeGh } from './testing/fake'

let dir: string
let repo: string
let bare: string
let noConfig: string
let fx: MissionFixture
let gh: FakeGh
let real: GitService
let missionId: string
/** Every address the service asked Git to push to: always GitHub's, and never actually used. */
let asked: string[]

const sh = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Setup',
      '-c',
      'user.email=setup@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: noConfig, GIT_CONFIG_NOSYSTEM: '1' },
    },
  ).trim()

const commitFile = (name: string, text = `${name}\n`): void => {
  writeFileSync(join(repo, name), text)
  sh(repo, 'add', '-A')
  sh(repo, 'commit', '-qm', `add ${name}`)
}

/** A project with a mission branch of two commits built on `main`, as the mission machinery leaves it. */
async function setup(extra: () => void = () => undefined): Promise<PullRequestService> {
  sh(repo, 'update-ref', 'refs/remotes/origin/main', sh(repo, 'rev-parse', 'main'))
  extra()
  const base = sh(repo, 'rev-parse', 'main')
  sh(repo, 'switch', '-q', '-c', missionBranch(missionId))
  commitFile('one.txt')
  commitFile('two.txt')
  sh(repo, 'switch', '-q', 'main')

  fx.services.db
    .prepare(
      `INSERT INTO github_links (mission_id, owner, repo, repo_root, issue_number, issue_title, issue_url, issue_author, issue_body, imported_at)
       VALUES (?, 'octo', 'widgets', ?, 42, 'Login form accepts an empty password', 'https://github.com/octo/widgets/issues/42', 'ada', '', 't')`,
    )
    .run(missionId, repo)
  fx.services.db
    .prepare(
      'INSERT INTO mission_branches (mission_id, repo_root, branch, base_commit, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(missionId, repo, missionBranch(missionId), base, 't')
  const task = fx.missions.createTask({
    missionId,
    title: 'Reject an empty password',
    assigneeId: 'mika',
  })
  fx.services.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id)

  gh = fakeGh({ login: 'octocat' })
  const client = new GitHubClient(
    new GhCli({
      platform: toPlatformId(),
      env: { PATH: process.env.PATH ?? '' },
      home: dir,
      executable: gh.executable,
      prefixArgs: gh.prefixArgs,
    }),
  )
  const links = new GitHubService({
    db: fx.services.db,
    events: fx.services.events,
    audit: fx.services.audit,
    missions: fx.missions,
    client,
    repos: { locate: async () => null },
    workingDirectories: () => [],
  })
  // Real Git for everything, except that the push goes to a local folder instead of the address it
  // was given (which is GitHub's), so a test can never reach GitHub.
  const git = {
    resolve: (...a: Parameters<GitService['resolve']>) => real.resolve(...a),
    commits: (...a: Parameters<GitService['commits']>) => real.commits(...a),
    diff: (...a: Parameters<GitService['diff']>) => real.diff(...a),
    commitsAhead: (...a: Parameters<GitService['commitsAhead']>) => real.commitsAhead(...a),
    remoteUrl: (...a: Parameters<GitService['remoteUrl']>) => real.remoteUrl(...a),
    remoteTip: (...a: Parameters<GitService['remoteTip']>) => real.remoteTip(...a),
    unsafeSettings: (...a: Parameters<GitService['unsafeSettings']>) => real.unsafeSettings(...a),
    push: async (r: string, url: string, branch: string, commit: string) => {
      asked.push(url)
      return real.push(r, pathToFileURL(bare).href, branch, commit)
    },
  }
  return new PullRequestService({
    db: fx.services.db,
    events: fx.services.events,
    audit: fx.services.audit,
    missions: fx.missions,
    link: (id) => links.link(id),
    git: git as unknown as PullRequestServiceDeps['git'],
    client,
    evidence: {
      collect: async () =>
        ({
          task: { agentSummary: 'Added a check.' },
          checks: { headline: 'All 1 check passed on the final commit.' },
          reviews: { headline: 'No independent review was made.' },
        }) as unknown as EvidencePack,
    },
  })
}

beforeEach(async () => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'shokuba-pulls-git-')))
  noConfig = join(dir, 'no-git-config')
  writeFileSync(noConfig, '')
  repo = join(dir, 'repo')
  bare = join(dir, 'remote.git')
  mkdirSync(repo)
  sh(repo, 'init', '-q', '-b', 'main')
  commitFile('base.txt')
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/octo/widgets.git')
  sh(dir, 'init', '--bare', '-q', '-b', 'main', bare)
  real = await GitService.locate({
    platform: toPlatformId(),
    env: process.env,
    home: homedir(),
    dataDir: join(dir, 'data'),
    gitEnv: { GIT_CONFIG_GLOBAL: noConfig, GIT_CONFIG_NOSYSTEM: '1' },
  })
  fx = createMissionFixture()
  fx.addEmployee('mika')
  missionId = fx.missions.createMission({ title: '#42 Login form accepts an empty password' }).id
  asked = []
})

afterEach(async () => {
  gh?.cleanup()
  fx.cleanup()
  await removeTree(dir)
})

describe('a pull request, with real Git', () => {
  it('lists the real commits, counts them, and finds nothing in the way', async () => {
    const preview = await (await setup()).preview({ missionId })
    expect(preview.problems).toEqual([])
    expect(preview.commitCount).toBe(2)
    expect(preview.commits.map((c) => c.subject)).toEqual(['add two.txt', 'add one.txt'])
    expect(preview.head).toBe(sh(repo, 'rev-parse', '--short=8', missionBranch(missionId)))
    expect(preview.unpublishedCommits).toBe(0)
    expect(preview.warnings).toEqual([])
  })

  it('warns about work of yours that was only ever local, which would be pushed with the branch', async () => {
    const service = await setup(() => commitFile('local-only.txt'))
    const preview = await service.preview({ missionId })
    expect(preview.unpublishedCommits).toBe(1)
    expect(preview.warnings.join(' ')).toMatch(/1 commit of yours .* not on GitHub yet/)
  })

  it('finds a secret in the real change, including in local work that would be pushed with it', async () => {
    const secret = ['ghp', '_', 'a'.repeat(36)].join('')
    const service = await setup(() => commitFile('local-only.txt', `token = ${secret}\n`))
    const preview = await service.preview({ missionId })
    expect(preview.problems.join(' ')).toMatch(/looks like a secret/)
    expect(JSON.stringify(preview)).not.toContain(secret)
  })

  it('will not push from a repository whose own settings run a program', async () => {
    const service = await setup(() =>
      sh(repo, 'config', '--local', 'core.sshCommand', 'echo pwned'),
    )
    const preview = await service.preview({ missionId })
    expect(preview.problems.join(' ')).toMatch(/core\.sshcommand\) run a program/)
    await expect(service.open({ missionId, hash: preview.hash, draft: true })).rejects.toThrow(
      /run a program/,
    )
    expect(sh(bare, 'for-each-ref')).toBe('')
  })

  it('pushes the previewed commit, and only that branch, and opens the pull request', async () => {
    const service = await setup()
    const preview = await service.preview({ missionId })
    const result = await service.open({ missionId, hash: preview.hash, draft: true })

    const head = sh(repo, 'rev-parse', missionBranch(missionId))
    expect(sh(bare, 'rev-parse', `refs/heads/${missionBranch(missionId)}`)).toBe(head)
    expect(sh(bare, 'for-each-ref', '--format=%(refname)')).toBe(
      `refs/heads/${missionBranch(missionId)}`,
    )
    // The address it was going to push to is GitHub's; the test sent it to a local folder instead.
    expect(asked).toEqual(['https://github.com/octo/widgets.git'])
    expect(result).toMatchObject({ number: 7, draft: true, existing: false })
    expect(gh.requests().filter((r) => r.args.includes('POST'))).toHaveLength(1)
    // None of your own branches moved.
    expect(sh(repo, 'rev-parse', 'main')).toBe(sh(repo, 'rev-parse', 'refs/remotes/origin/main'))
  })

  it('refuses when work was added to the branch after the preview, and pushes nothing', async () => {
    const service = await setup()
    const preview = await service.preview({ missionId })
    sh(repo, 'switch', '-q', missionBranch(missionId))
    commitFile('late.txt')
    sh(repo, 'switch', '-q', 'main')
    await expect(service.open({ missionId, hash: preview.hash, draft: true })).rejects.toThrow(
      /Something changed/,
    )
    expect(sh(bare, 'for-each-ref')).toBe('')
    expect(asked).toEqual([])
  })
})
