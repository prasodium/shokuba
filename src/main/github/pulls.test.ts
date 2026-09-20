import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GitHubLink } from '@shared/github'
import type { EvidencePack } from '../evidence/types'
import { GitError } from '../git/runner'
import { missionBranch } from '../git/refs'
import { createMissionFixture, type MissionFixture } from '../missions/fixtures'
import { toPlatformId } from '../platform'
import { GitHubClient } from './client'
import { GhCli } from './gh'
import { PullRequestService, type PullRequestServiceDeps } from './pulls'
import { GitHubError, GitHubService } from './service'
import { fakeGh, type FakeGh, type FakeGhScript } from './testing/fake'

const REPO_ROOT = '/work/widgets'
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const TIP = 'c'.repeat(40)

let fx: MissionFixture
let gh: FakeGh
let missionId: string

/** A stand-in for Git that says what a repository would, and records every push it is asked for. */
class StubGit {
  head: string | null = HEAD
  ahead = 2
  unpublished = 0
  tip: string | null = null
  pushUrl: string | null = 'https://github.com/octo/widgets.git'
  unsafe: string[] = []
  diffText = 'diff --git a/login.ts b/login.ts\n+if (!password) throw new Error("empty")\n'
  diffTruncated = false
  subjects = ['Add a test', 'Reject an empty password']
  pushes: Array<{ repo: string; url: string; branch: string; commit: string }> = []
  diffs: Array<{ from: string; to: string }> = []
  pushError: Error | null = null
  pushGate: Promise<void> | null = null

  resolve = async (_repo: string, revision: string) =>
    revision === missionBranch(missionId) ? this.head : null
  commitsAhead = async (_repo: string, from: string, to: string) =>
    from === BASE && to === missionBranch(missionId) ? this.ahead : this.unpublished
  commits = async () => ({
    commits: this.subjects.map((subject, i) => ({
      commit: `${String(i).repeat(40)}`,
      author: 'Mika',
      date: '2026-01-01T00:00:00Z',
      merge: false,
      subject,
    })),
    truncated: false,
  })
  diff = async (_repo: string, from: string, to: string) => {
    this.diffs.push({ from, to })
    return { text: this.diffText, truncated: this.diffTruncated }
  }
  remoteUrl = async () => this.pushUrl
  remoteTip = async () => this.tip
  unsafeSettings = async () => this.unsafe
  push = async (repo: string, url: string, branch: string, commit: string) => {
    if (this.pushGate) await this.pushGate
    if (this.pushError) throw this.pushError
    this.pushes.push({ repo, url, branch, commit })
    return 'created' as const
  }
}

let git: StubGit | undefined
let evidence: PullRequestServiceDeps['evidence']

const pack = (summary: string | null): EvidencePack =>
  ({
    task: { agentSummary: summary },
    checks: { headline: 'All 2 checks passed on the final commit.' },
    reviews: { headline: 'The reviewer approved the work on the final commit, with no findings.' },
  }) as unknown as EvidencePack

function build(script: Partial<FakeGhScript> = {}) {
  gh?.cleanup()
  gh = fakeGh({ login: 'octocat', ...script })
  const client = new GitHubClient(
    new GhCli({
      platform: toPlatformId(),
      env: { PATH: process.env.PATH ?? '' },
      home: tmpdir(),
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
  return new PullRequestService({
    db: fx.services.db,
    events: fx.services.events,
    audit: fx.services.audit,
    missions: fx.missions,
    link: (id) => links.link(id),
    git: git as unknown as PullRequestServiceDeps['git'],
    client,
    evidence: { collect: (taskId) => evidence.collect(taskId) },
  })
}

const linkRow = (title = 'Login form accepts an empty password') => {
  fx.services.db
    .prepare(
      `INSERT INTO github_links (mission_id, owner, repo, repo_root, issue_number, issue_title, issue_url, issue_author, issue_body, imported_at)
       VALUES (?, 'octo', 'widgets', ?, 42, ?, 'https://github.com/octo/widgets/issues/42', 'ada', 'It signs in.', 't')`,
    )
    .run(missionId, REPO_ROOT, title)
}

/** The endpoint of each request `gh` was asked to make, and how. */
const asked = () =>
  gh.requests().map((r) => {
    const path = r.args.find((a) => /^(user|repos\/.+)$/.test(a)) ?? '?'
    return `${r.args.includes('POST') ? 'POST' : 'GET'} ${path}`
  })
const posts = () => gh.requests().filter((r) => r.args.includes('POST'))

beforeEach(() => {
  fx = createMissionFixture()
  fx.addEmployee('mika')
  const mission = fx.missions.createMission({ title: '#42 Login form accepts an empty password' })
  missionId = mission.id
  linkRow()
  fx.services.db
    .prepare(
      'INSERT INTO mission_branches (mission_id, repo_root, branch, base_commit, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(missionId, REPO_ROOT, missionBranch(missionId), BASE, 't')
  const task = fx.missions.createTask({
    missionId,
    title: 'Reject an empty password',
    assigneeId: 'mika',
  })
  fx.services.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id)
  git = new StubGit()
  evidence = { collect: async () => pack('Added a check and a test.') }
})
afterEach(() => {
  gh?.cleanup()
  fx.cleanup()
})

const record = () =>
  fx.services.db
    .prepare('SELECT pr_number, pr_draft, pr_head FROM github_links WHERE mission_id = ?')
    .get(missionId)
const refusal = async (work: Promise<unknown>): Promise<GitHubError> => {
  try {
    await work
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubError)
    return error as GitHubError
  }
  throw new Error('expected a refusal')
}

describe('preview', () => {
  it('shows exactly what would be done: who as, where from and to, the commits, the title and the text', async () => {
    const preview = await build({ defaultBranch: 'trunk' }).preview({ missionId })
    expect(preview).toMatchObject({
      missionId,
      repo: 'octo/widgets',
      login: 'octocat',
      branch: `shokuba/mission/${missionId}`,
      base: 'trunk',
      head: 'aaaaaaaa',
      commitCount: 2,
      title: 'Login form accepts an empty password',
      problems: [],
    })
    expect(preview.commits.map((c) => c.subject)).toEqual([
      'Add a test',
      'Reject an empty password',
    ])
    expect(preview.body.split('\n')[0]).toBe('Closes #42')
    expect(preview.body).toContain('### `Reject an empty password`')
    expect(preview.body).toContain('Added a check and a test.')
    expect(preview.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('writes nothing: no push, no request that changes anything, no record, no event', async () => {
    const service = build()
    const events = fx.services.events.log.count()
    const audits = fx.services.audit.list().length
    await service.preview({ missionId })
    expect(git?.pushes).toEqual([])
    expect(posts()).toHaveLength(0)
    expect(record()).toEqual({ pr_number: null, pr_draft: 0, pr_head: null })
    expect(fx.services.events.log.count()).toBe(events)
    expect(fx.services.audit.list()).toHaveLength(audits)
  })

  it('has the same hash each time it is looked at, and a different one when anything shown changes', async () => {
    const first = (await build().preview({ missionId })).hash
    expect((await build().preview({ missionId })).hash).toBe(first)

    const changed = async (change: () => void, script: Partial<FakeGhScript> = {}) => {
      change()
      return (await build(script).preview({ missionId })).hash
    }
    const other = new Set([
      await changed(() => {
        if (git) git.head = 'd'.repeat(40)
      }),
      await changed(() => {
        if (git) git.head = HEAD
        evidence = { collect: async () => pack('Something else.') }
      }),
      await changed(
        () => {
          evidence = { collect: async () => pack('Added a check and a test.') }
        },
        { defaultBranch: 'trunk' },
      ),
      await changed(() => undefined, { openPulls: [{ number: 3 }] }),
      await changed(() => {
        if (git) git.unpublished = 0
        git!.ahead = 3
      }),
    ])
    expect(other.size).toBe(5)
    expect(other.has(first)).toBe(false)
  })

  it('covers the full commit, not just the short one shown', async () => {
    const first = (await build().preview({ missionId })).hash
    if (git) git.head = `aaaaaaaa${'e'.repeat(32)}`
    const second = await build().preview({ missionId })
    expect(second.head).toBe('aaaaaaaa')
    expect(second.hash).not.toBe(first)
  })

  it('finds an open pull request for the branch and says opening would only push to it', async () => {
    const preview = await build({ openPulls: [{ number: 3, draft: true }] }).preview({ missionId })
    expect(preview.existing).toEqual({
      number: 3,
      url: 'https://github.com/octo/widgets/pull/3',
      draft: true,
    })
    expect(preview.warnings.join(' ')).toMatch(/already open \(#3\).*will not open a second one/)
    expect(preview.problems).toEqual([])
  })

  it('says when tasks are not done, and counts none for cancelled ones', async () => {
    fx.missions.createTask({ missionId, title: 'Still to do' })
    const cancelled = fx.missions.createTask({ missionId, title: 'Dropped' })
    fx.services.db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(cancelled.id)
    const preview = await build().preview({ missionId })
    expect(preview.tasksNotDone).toBe(1)
    expect(preview.warnings.join(' ')).toMatch(/1 task is not done/)
    expect(preview.body).toContain('1 other task was not finished')
  })

  it('warns when the history it is built on holds commits that are not on GitHub yet, and searches them for secrets too', async () => {
    if (git) {
      git.tip = TIP
      git.unpublished = 3
    }
    const preview = await build().preview({ missionId })
    expect(preview.unpublishedCommits).toBe(3)
    expect(preview.warnings.join(' ')).toMatch(
      /3 commits of yours .* not on GitHub yet.*pushed with the branch/,
    )
    expect(git?.diffs[0]).toEqual({ from: TIP, to: HEAD })
  })

  it('says it cannot tell when GitHub’s branch was never fetched, and searches from where the mission began', async () => {
    const preview = await build().preview({ missionId })
    expect(preview.unpublishedCommits).toBeNull()
    expect(preview.warnings.join(' ')).toMatch(/could not tell whether the history/)
    expect(git?.diffs[0]).toEqual({ from: BASE, to: HEAD })
  })

  it('cannot be opened when nothing has been accepted yet', async () => {
    for (const change of [
      () => {
        if (git) git.ahead = 0
      },
      () => {
        if (git) git.head = null
      },
    ]) {
      git = new StubGit()
      change()
      const preview = await build().preview({ missionId })
      expect(preview.problems.join(' ')).toMatch(/Nothing has been accepted/)
    }
  })

  it('cannot be opened when the mission has no recorded start', async () => {
    fx.services.db.prepare('DELETE FROM mission_branches').run()
    expect((await build().preview({ missionId })).problems.join(' ')).toMatch(
      /Nothing has been accepted/,
    )
  })

  it('cannot be opened twice: a pull request already recorded is a problem', async () => {
    fx.services.db
      .prepare("UPDATE github_links SET pr_number = 9, pr_opened_at = 't' WHERE mission_id = ?")
      .run(missionId)
    expect((await build().preview({ missionId })).problems.join(' ')).toMatch(
      /already opened for this mission/,
    )
  })

  it('cannot be opened when origin no longer points at this repository, or is not encrypted', async () => {
    for (const url of [
      null,
      'https://github.com/octo/other.git',
      'https://github.com/evil/widgets.git',
      'https://gitlab.com/octo/widgets.git',
      '/somewhere/local',
    ]) {
      if (git) git.pushUrl = url
      const preview = await build().preview({ missionId })
      expect(preview.problems.join(' '), String(url)).toMatch(/no longer points to octo\/widgets/)
    }
    for (const url of ['http://github.com/octo/widgets.git', 'git://github.com/octo/widgets.git']) {
      if (git) git.pushUrl = url
      expect((await build().preview({ missionId })).problems.join(' '), url).toMatch(/unencrypted/)
    }
    for (const url of [
      'https://github.com/octo/widgets.git',
      'git@github.com:octo/widgets.git',
      'ssh://git@github.com/octo/widgets.git',
    ]) {
      if (git) git.pushUrl = url
      expect((await build().preview({ missionId })).problems, url).toEqual([])
    }
  })

  it('cannot be opened when the repository’s own settings run a program', async () => {
    if (git) git.unsafe = ['core.sshcommand', 'url.*']
    const preview = await build().preview({ missionId })
    expect(preview.problems.join(' ')).toMatch(/core\.sshcommand, url\.\*\) run a program/)
  })

  it('will not publish a change that holds a secret, and names only the kind', async () => {
    const secret = ['ghp', '_', 'a'.repeat(36)].join('')
    if (git) git.diffText = `+const token = "${secret}"\n`
    const preview = await build().preview({ missionId })
    expect(preview.problems.join(' ')).toMatch(/looks like a secret/)
    expect(JSON.stringify(preview)).not.toContain(secret)
  })

  it('will not publish a change it is too large to search', async () => {
    if (git) git.diffTruncated = true
    expect((await build().preview({ missionId })).problems.join(' ')).toMatch(/too large/)
  })

  it('will not publish text that holds a secret, such as an issue title', async () => {
    const secret = ['ghp', '_', 'b'.repeat(36)].join('')
    fx.services.db.prepare('DELETE FROM github_links').run()
    linkRow(`Leaked ${secret}`)
    const preview = await build().preview({ missionId })
    expect(preview.problems.join(' ')).toMatch(/text holds something that looks like a secret/)
  })

  it('refuses what is not a mission from an issue, and asks nothing of GitHub for it', async () => {
    const plain = fx.missions.createMission({ title: 'Plain' })
    const service = build()
    expect((await refusal(service.preview({ missionId: plain.id }))).message).toMatch(
      /does not come from/,
    )
    expect((await refusal(service.preview({ missionId: 'nope' }))).code).toBe('invalid')
    for (const bad of [{}, { missionId: '' }, { missionId, x: 1 }, null]) {
      expect(await refusal(service.preview(bad as never))).toBeInstanceOf(GitHubError)
    }
    expect(gh.requests()).toHaveLength(0)
  })

  it('refuses when Git is not available', async () => {
    git = undefined
    expect((await refusal(build().preview({ missionId }))).message).toMatch(/Git is not available/)
  })

  it('refuses an archived mission, though its link is still there', async () => {
    fx.missions.missionAction(missionId, 'cancel')
    fx.missions.archiveMission(missionId)
    expect((await refusal(build().preview({ missionId }))).message).toMatch(/no such mission/)
  })
})

describe('open', () => {
  const opened = async (service: PullRequestService, draft = true) => {
    const { hash } = await service.preview({ missionId })
    return service.open({ missionId, hash, draft })
  }

  it('pushes the previewed commit and opens the pull request, as the preview said', async () => {
    const service = build()
    const preview = await service.preview({ missionId })
    const result = await service.open({ missionId, hash: preview.hash, draft: true })

    expect(result).toEqual({
      number: 7,
      url: 'https://github.com/octo/widgets/pull/7',
      draft: true,
      existing: false,
    })
    expect(git?.pushes).toEqual([
      {
        repo: REPO_ROOT,
        url: 'https://github.com/octo/widgets.git',
        branch: preview.branch,
        commit: HEAD,
      },
    ])
    const [post] = posts()
    expect(JSON.parse(post?.input ?? '')).toEqual({
      title: preview.title,
      body: preview.body,
      head: preview.branch,
      base: preview.base,
      draft: true,
    })
  })

  it('opens it as a draft or not, as the person chose', async () => {
    await opened(build(), false)
    expect(JSON.parse(posts()[0]?.input ?? '').draft).toBe(false)
  })

  it('records it, as a change to the mission’s link, an event and two audit entries', async () => {
    await opened(build())
    expect(record()).toEqual({ pr_number: 7, pr_draft: 1, pr_head: HEAD })
    const link = new GitHubService({
      db: fx.services.db,
      events: fx.services.events,
      audit: fx.services.audit,
      missions: fx.missions,
      client: new GitHubClient(
        new GhCli({ platform: toPlatformId(), env: {}, home: tmpdir(), find: async () => null }),
      ),
      repos: { locate: async () => null },
      workingDirectories: () => [],
    }).link(missionId) as GitHubLink
    expect(link.pullRequest).toMatchObject({
      number: 7,
      url: 'https://github.com/octo/widgets/pull/7',
      draft: true,
    })

    const [event] = fx.services.events.log.list({ type: 'github.pull.opened' })
    expect(event).toMatchObject({
      source: 'user',
      missionId,
      payload: { missionId, repo: 'octo/widgets', number: 7, draft: true },
    })
    const audits = fx.services.audit.list().filter((a) => a.action.startsWith('github.pull.'))
    expect(audits.map((a) => a.action)).toEqual(['github.pull.push', 'github.pull.open'])
    expect(audits[0]?.detail).toMatchObject({ repo: 'octo/widgets', outcome: 'created' })
    expect(audits[1]?.detail).toMatchObject({ number: 7, draft: true, existing: false })
  })

  it('puts no text in the event or the audit log, only the repository, numbers and branch', async () => {
    await opened(build())
    const written = JSON.stringify([
      fx.services.events.log.list({ type: 'github.pull.opened' }),
      fx.services.audit.list().filter((a) => a.action.startsWith('github.pull.')),
    ])
    expect(written).not.toContain('Login form')
    expect(written).not.toContain('Added a check')
    expect(written).not.toContain('Closes #42')
  })

  it('does nothing else to GitHub: one pull request, and no comment, no merge, no other write', async () => {
    await opened(build())
    expect(asked().filter((a) => a.startsWith('POST'))).toEqual(['POST repos/octo/widgets/pulls'])
    const allowed = [
      'GET user',
      'GET repos/octo/widgets',
      'GET repos/octo/widgets/pulls',
      'POST repos/octo/widgets/pulls',
    ]
    expect(asked().filter((a) => !allowed.includes(a))).toEqual([])
    expect(JSON.stringify(gh.requests())).not.toMatch(/merge|comments|reviews|issues\/42/)
  })

  it('refuses if anything shown has changed since it was looked at, and does nothing', async () => {
    const service = build()
    const { hash } = await service.preview({ missionId })
    if (git) git.head = 'd'.repeat(40)
    expect((await refusal(service.open({ missionId, hash, draft: true }))).code).toBe('changed')
    if (git) git.head = HEAD
    evidence = { collect: async () => pack('Rewritten after you looked.') }
    expect((await refusal(service.open({ missionId, hash, draft: true }))).code).toBe('changed')
    expect(git?.pushes).toEqual([])
    expect(posts()).toHaveLength(0)
    expect(record()).toEqual({ pr_number: null, pr_draft: 0, pr_head: null })
  })

  it('refuses if GitHub changed: the default branch moved, or someone opened one', async () => {
    const before = await build().preview({ missionId })
    for (const script of [{ defaultBranch: 'trunk' }, { openPulls: [{ number: 5 }] }]) {
      const error = await refusal(build(script).open({ missionId, hash: before.hash, draft: true }))
      expect(error.code, JSON.stringify(script)).toBe('changed')
    }
    expect(git?.pushes).toEqual([])
  })

  it('refuses a hash that is made up or the wrong shape, before doing anything', async () => {
    const service = build()
    for (const hash of ['', 'x', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), '0'.repeat(64)]) {
      expect(await refusal(service.open({ missionId, hash, draft: true })), hash).toBeInstanceOf(
        GitHubError,
      )
    }
    expect(git?.pushes).toEqual([])
    expect(posts()).toHaveLength(0)
    await expect(
      service.open({ missionId, hash: '0'.repeat(64), draft: 'yes' } as never),
    ).rejects.toBeInstanceOf(GitHubError)
  })

  it('refuses when there is a problem, even though the hash matches what was shown', async () => {
    const secret = ['ghp', '_', 'c'.repeat(36)].join('')
    if (git) git.diffText = `+${secret}\n`
    const service = build()
    const preview = await service.preview({ missionId })
    expect(preview.problems).not.toEqual([])
    const error = await refusal(service.open({ missionId, hash: preview.hash, draft: true }))
    expect(error.code).toBe('blocked')
    expect(error.message).toMatch(/looks like a secret/)
    expect(git?.pushes).toEqual([])
    expect(posts()).toHaveLength(0)
  })

  it('opens nothing twice: a second try after success is refused', async () => {
    const service = build()
    await opened(service)
    const again = await refusal(opened(service))
    expect(again.message).toMatch(/already opened for this mission/)
    expect(git?.pushes).toHaveLength(1)
    expect(posts()).toHaveLength(1)
  })

  it('when a pull request is already open, pushes the new commits to it and opens no second one', async () => {
    const result = await opened(build({ openPulls: [{ number: 3, draft: false }] }))
    expect(result).toEqual({
      number: 3,
      url: 'https://github.com/octo/widgets/pull/3',
      draft: false,
      existing: true,
    })
    expect(git?.pushes).toHaveLength(1)
    expect(posts()).toHaveLength(0)
    expect(record()).toEqual({ pr_number: 3, pr_draft: 0, pr_head: HEAD })
  })

  it('records nothing and asks GitHub for nothing when the push fails, and passes on why', async () => {
    if (git) git.pushError = new GitError('failed', 'Git could not sign in to push.')
    const error = await opened(build()).catch((e: unknown) => e)
    expect((error as Error).message).toMatch(/could not sign in/)
    expect(posts()).toHaveLength(0)
    expect(record()).toEqual({ pr_number: null, pr_draft: 0, pr_head: null })
    expect(fx.services.audit.list().filter((a) => a.action.startsWith('github.pull.'))).toEqual([])
  })

  it('says the branch was pushed when GitHub then refuses the pull request, records the push only, and can be tried again', async () => {
    const failing = build({
      pullError: {
        status: 422,
        message: 'Draft pull requests are not supported in this repository.',
      },
    })
    const error = await refusal(opened(failing))
    expect(error.code).toBe('pushed')
    expect(error.message).toMatch(
      /branch was pushed to GitHub, but the pull request could not be opened/,
    )
    expect(record()).toEqual({ pr_number: null, pr_draft: 0, pr_head: null })
    expect(
      fx.services.audit
        .list()
        .filter((a) => a.action.startsWith('github.pull.'))
        .map((a) => a.action),
    ).toEqual(['github.pull.push'])

    expect((await opened(build(), false)).number).toBe(7)
    expect(git?.pushes).toHaveLength(2)
  })

  it('never opens the same one twice at once: a second click while the first is working is refused', async () => {
    let release = () => {}
    if (git)
      git.pushGate = new Promise<void>((resolve) => {
        release = resolve
      })
    const service = build()
    const { hash } = await service.preview({ missionId })
    const first = service.open({ missionId, hash, draft: true })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect((await refusal(service.open({ missionId, hash, draft: true }))).code).toBe('busy')
    release()
    await first
    expect(git?.pushes).toHaveLength(1)
    expect(posts()).toHaveLength(1)
  })

  it('lets the next one through once the first has finished, whether it worked or not', async () => {
    if (git) git.pushError = new GitError('failed', 'nope')
    const service = build()
    await opened(service).catch(() => undefined)
    if (git) git.pushError = null
    expect((await opened(service)).number).toBe(7)
  })
})
