import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PermissionMode } from '@shared/employees'
import type { Task } from '@shared/missions'
import type { ReviewSubmit } from '@shared/reviews'
import { AgentLock } from '../agents/lock'
import { GitService } from '../git/service'
import { createLogger } from '../logging/logger'
import { createMissionFixture, type MissionFixture } from '../missions/fixtures'
import { removeTree, toPlatformId } from '../platform'
import { WorkspaceService, type WorkspaceEmployee } from '../workspaces/service'
import { ReviewError, ReviewService, type ReviewDelivery } from './service'

let dir: string
let repo: string
let noConfig: string
let fx: MissionFixture
let git: GitService
let workspaces: WorkspaceService
let reviews: ReviewService
let missionId: string
let lock: AgentLock
let delivery: FakeDelivery
let allowed: boolean
let interrupted: string[]
let clock: number

const SECRET_SUMMARY = 'SECRET-SUMMARY-the-author-says-it-is-perfect'

/** A stand-in for the runtime: who can be handed input, where they work, and what they were sent. */
class FakeDelivery implements ReviewDelivery {
  readonly ready = new Set<string>()
  readonly where = new Map<string, string>()
  readonly restarts: Array<{ id: string; cwd: string; mode: PermissionMode | undefined }> = []
  readonly delivered: Array<{ id: string; text: string }> = []
  failWith: string | null = null
  /** Runs while the reviewer is being moved, to change things under the service's feet. */
  onRestart: (() => void) | null = null
  /** Whether the reviewer is still ready for input once they have been moved. */
  readyAfterRestart = true
  deliveryBlocker(id: string): string | null {
    return this.ready.has(id) ? null : 'is busy'
  }
  async deliverPrompt(id: string, text: string): Promise<void> {
    if (this.failWith) throw new Error(this.failWith)
    this.delivered.push({ id, text })
  }
  cwdOf(id: string): string | undefined {
    return this.where.get(id)
  }
  async restartIn(
    id: string,
    cwd: string,
    options?: { permissionMode?: PermissionMode },
  ): Promise<void> {
    this.restarts.push({ id, cwd, mode: options?.permissionMode })
    this.where.set(id, realpathSync.native(cwd))
    if (!this.readyAfterRestart) this.ready.delete(id)
    this.onRestart?.()
  }
}

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
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
}

beforeEach(async () => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'shokuba-reviews-')))
  noConfig = join(dir, 'no-git-config')
  writeFileSync(noConfig, '')
  repo = join(dir, 'repo')
  mkdirSync(repo)
  sh(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  sh(repo, 'add', '-A')
  sh(repo, 'commit', '-qm', 'base')

  fx = createMissionFixture()
  for (const [id, name] of [
    ['ren', 'Ren'],
    ['sora', 'Sora'],
    ['mika', 'Mika'],
  ] as const)
    fx.addEmployee(id, name)
  const people = new Map<string, WorkspaceEmployee>(
    ['ren', 'sora', 'mika'].map((id) => [id, { id, name: id, workingDirectory: repo }]),
  )
  git = await GitService.locate({
    platform: toPlatformId(),
    env: process.env,
    home: homedir(),
    dataDir: join(dir, 'data'),
    gitEnv: { GIT_CONFIG_GLOBAL: noConfig, GIT_CONFIG_NOSYSTEM: '1' },
  })
  workspaces = new WorkspaceService({
    db: fx.services.db,
    events: fx.services.events,
    missions: fx.missions,
    employees: { get: (id) => people.get(id) },
    git,
    platform: toPlatformId(),
    logger: createLogger(() => {}),
  })
  lock = new AgentLock()
  delivery = new FakeDelivery()
  allowed = true
  interrupted = []
  clock = 1_000_000
  reviews = build()
  reviews.start()
  missionId = fx.missions.createMission({ title: 'Ship login' }).id
  fx.missions.missionAction(missionId, 'run')
})

afterEach(async () => {
  reviews.stop()
  fx.cleanup()
  await removeTree(dir)
})

function build(): ReviewService {
  return new ReviewService({
    db: fx.services.db,
    events: fx.services.events,
    audit: fx.services.audit,
    git,
    missions: fx.missions,
    employees: {
      get: (id) => (['ren', 'sora', 'mika'].includes(id) ? { id, name: id } : undefined),
    },
    workspaces,
    delivery,
    allows: () => allowed,
    lock,
    interrupt: (id) => void interrupted.push(id),
    logger: createLogger(() => {}),
    now: () => new Date(clock),
  })
}

/** The author's whole turn: work in its own folder, and submit with an account of it. */
async function submitted(title = 'Build the login', file = 'login.ts'): Promise<Task> {
  const t = fx.missions.createTask({
    missionId,
    title,
    description: 'Validate the email and show errors inline.',
    assigneeId: 'ren',
  })
  fx.missions.markDispatched(t.id)
  const prepared = await workspaces.prepare(t)
  writeFileSync(join(prepared?.cwd ?? '', file), 'export const login = () => true\n')
  await workspaces.commit(t) // what happens just before an agent's submission is recorded
  fx.missions.agentSubmit('ren', { summary: SECRET_SUMMARY }, { source: 'reported' })
  return fx.missions.getTask(t.id) as Task
}

const rowFor = (t: Task) =>
  fx.services.db
    .prepare('SELECT * FROM reviews WHERE task_id = ? ORDER BY created_at DESC, rowid DESC')
    .get(t.id) as
    | {
        id: string
        state: string
        commit_id: string
        base_commit: string
        requested_by: string
        reviewer_id: string
      }
    | undefined
const stateOf = (t: Task): string | undefined => rowFor(t)?.state

const finding = {
  severity: 'major' as const,
  file: 'src/login.ts',
  line: 3,
  note: 'The email is not validated.',
}
const verdict = (patch: Partial<ReviewSubmit> = {}): ReviewSubmit => ({
  verdict: 'request_changes',
  summary: 'Does not validate the email.',
  findings: [finding],
  ...patch,
})

function refusal(work: () => unknown): ReviewError {
  try {
    work()
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewError)
    return error as ReviewError
  }
  throw new Error('expected a refusal')
}
async function refused(work: Promise<unknown>): Promise<ReviewError> {
  try {
    await work
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewError)
    return error as ReviewError
  }
  throw new Error('expected a refusal')
}

describe('asking for a review', () => {
  it('queues it against the exact commit the author submitted, and the change is measured from the mission branch', async () => {
    const t = await submitted()
    await reviews.request(t.id, 'sora', 'manual')
    const row = rowFor(t)
    expect(row).toMatchObject({ state: 'queued', requested_by: 'manual', reviewer_id: 'sora' })
    expect(row?.commit_id).toBe(sh(repo, 'rev-parse', `shokuba/task/${t.id}`))
    expect(row?.base_commit).toBe(sh(repo, 'rev-parse', `shokuba/mission/${missionId}`))
    expect(fx.eventsOf('review.changed').at(-1)).toMatchObject({
      payload: { change: 'requested', reviewerId: 'sora' },
    })
  })

  it('saves work that is not yet a commit first, so the review names everything the reviewer will read', async () => {
    const t = await submitted()
    writeFileSync(
      join(workspaces.infoFor(t.id)?.folder ?? '', 'late.ts'),
      'export const late = 1\n',
    )
    await reviews.request(t.id, 'sora', 'manual')
    expect(sh(repo, 'show', `${rowFor(t)?.commit_id}:late.ts`)).toBe('export const late = 1')
  })

  it('records who asked, in the audit log', async () => {
    const t = await submitted()
    await reviews.request(t.id, 'sora', 'manual')
    const audit = fx.services.db
      .prepare("SELECT actor, target FROM audit_log WHERE action = 'review.request'")
      .get()
    expect(audit).toEqual({ actor: 'user', target: t.id })
  })

  it('will not have the author review their own work', async () => {
    const t = await submitted()
    const error = await refused(reviews.request(t.id, 'ren', 'manual'))
    expect(error.message).toBe('The author cannot review their own work: choose someone else.')
    expect(rowFor(t)).toBeUndefined()
  })

  it('needs a reviewer, and one that exists', async () => {
    const t = await submitted()
    expect((await refused(reviews.request(t.id, null, 'manual'))).message).toBe(
      'Choose who should review it.',
    )
    expect((await refused(reviews.request(t.id, 'nobody', 'manual'))).message).toBe(
      'That employee does not exist.',
    )
  })

  it('uses the project’s reviewer when none is named', async () => {
    const t = await submitted()
    reviews.saveSettings({ repoRoot: repo, reviewerId: 'sora', auto: false })
    await reviews.request(t.id, null, 'manual')
    expect(rowFor(t)?.reviewer_id).toBe('sora')
  })

  it('only reviews work the author has stopped changing', async () => {
    const t = fx.missions.createTask({ missionId, title: 'Still going', assigneeId: 'ren' })
    fx.missions.markDispatched(t.id)
    await workspaces.prepare(t)
    expect((await refused(reviews.request(t.id, 'sora', 'manual'))).message).toBe(
      'The work can only be reviewed once the agent has submitted it.',
    )
  })

  it('only reviews work in its own folder', async () => {
    const t = fx.missions.createTask({ missionId, title: 'No folder', assigneeId: 'ren' })
    expect((await refused(reviews.request(t.id, 'sora', 'manual'))).message).toBe(
      'That task has no working folder of its own to review.',
    )
  })

  it('does not ask twice for the same work while one is under way', async () => {
    const t = await submitted()
    await reviews.request(t.id, 'sora', 'manual')
    expect((await refused(reviews.request(t.id, 'mika', 'manual'))).message).toBe(
      'A review of this task is already under way.',
    )
  })
})

describe('the settings', () => {
  it('keep who reviews a project and whether it is asked for automatically', () => {
    expect(reviews.getSettings(repo)).toEqual({ repoRoot: repo, reviewerId: null, auto: false })
    expect(reviews.saveSettings({ repoRoot: repo, reviewerId: 'sora', auto: true })).toEqual({
      repoRoot: repo,
      reviewerId: 'sora',
      auto: true,
    })
  })

  it('cannot switch automatic review on without a reviewer, or name someone who does not exist', () => {
    expect(reviews.saveSettings({ repoRoot: repo, reviewerId: null, auto: true }).auto).toBe(false)
    expect(
      refusal(() => reviews.saveSettings({ repoRoot: repo, reviewerId: 'nobody', auto: false }))
        .code,
    ).toBe('invalid')
    expect(
      refusal(() =>
        reviews.saveSettings({ repoRoot: repo, reviewerId: 'sora', auto: true, extra: 1 }),
      ).code,
    ).toBe('invalid')
  })
})

describe('handing a review to the reviewer', () => {
  it('puts them in a read-only folder at the submitted commit, in plan mode, and pastes what to review', async () => {
    const t = await submitted()
    delivery.ready.add('sora')
    await reviews.request(t.id, 'sora', 'manual')
    await reviews.tick()

    expect(stateOf(t)).toBe('in_progress')
    const [restart] = delivery.restarts
    expect(restart).toMatchObject({ id: 'sora', mode: 'plan' })
    // The folder is the code exactly as submitted, on no branch.
    expect(sh(restart?.cwd ?? '', 'rev-parse', 'HEAD')).toBe(rowFor(t)?.commit_id)
    expect(sh(restart?.cwd ?? '', 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    expect(readFileSync(join(restart?.cwd ?? '', 'login.ts'), 'utf8')).toBe(
      'export const login = () => true\n',
    )

    const text = delivery.delivered[0]?.text ?? ''
    expect(delivery.delivered[0]?.id).toBe('sora')
    expect(text.startsWith('[Shokuba review]')).toBe(true)
    expect(text).toContain('Build the login')
    expect(text).toContain('Validate the email and show errors inline.')
    expect(text).toContain('+export const login = () => true')
    expect(text).toContain('- login.ts (+1 -0)')
    expect(fx.eventsOf('review.changed').at(-1)).toMatchObject({ payload: { change: 'started' } })
  })

  it('never tells the reviewer what the author says they did', async () => {
    const t = await submitted()
    expect(fx.missions.getTask(t.id)?.summary).toBe(SECRET_SUMMARY) // it is on record, so it could have leaked
    delivery.ready.add('sora')
    await reviews.request(t.id, 'sora', 'manual')
    await reviews.tick()
    const text = delivery.delivered[0]?.text ?? ''
    expect(text).not.toContain(SECRET_SUMMARY)
    expect(text).not.toContain('perfect')
    expect(text).not.toContain('says it')
    const again = (await reviews.current('sora')) ?? ''
    expect(again).not.toContain(SECRET_SUMMARY)
  })

  it('waits for a reviewer who is busy, who has a task, or who is limited, and goes when they are free', async () => {
    const t = await submitted()
    await reviews.request(t.id, 'sora', 'manual')
    await reviews.tick()
    expect(stateOf(t)).toBe('queued') // not ready for input

    delivery.ready.add('sora')
    const theirs = fx.missions.createTask({ missionId, title: 'Their own', assigneeId: 'sora' })
    fx.missions.markDispatched(theirs.id) // an active task of their own
    await reviews.tick()
    expect(stateOf(t)).toBe('queued')
    fx.missions.agentSubmit('sora', { summary: 'done' }, { source: 'reported' })

    allowed = false
    await reviews.tick()
    expect(stateOf(t)).toBe('queued')
    allowed = true
    // In none of those cases was the reviewer moved: restarting someone who is busy loses their work.
    expect(delivery.restarts).toEqual([])
    expect(delivery.delivered).toEqual([])
    await reviews.tick()
    expect(stateOf(t)).toBe('in_progress')
  })

  it('does not move a reviewer while something else holds them', async () => {
    const t = await submitted()
    delivery.ready.add('sora')
    lock.acquire('sora') // held before the review is asked for, as the pass runs as soon as it is
    await reviews.request(t.id, 'sora', 'manual')
    await reviews.tick()
    expect(stateOf(t)).toBe('queued')
    expect(delivery.restarts).toEqual([])
    lock.release('sora')
    await reviews.tick()
    expect(stateOf(t)).toBe('in_progress')
    expect(lock.isHeld('sora')).toBe(false) // and lets go again once it is done
  })

  it('gives a reviewer one review at a time', async () => {
    const first = await submitted('First', 'first.ts')
    const second = await submitted('Second', 'second.ts')
    delivery.ready.add('sora')
    await reviews.request(first.id, 'sora', 'manual')
    await reviews.request(second.id, 'sora', 'manual')
    await reviews.tick()
    expect([stateOf(first), stateOf(second)]).toEqual(['in_progress', 'queued'])
    await reviews.tick() // asked again while they are still reading: still one at a time
    expect([stateOf(first), stateOf(second)]).toEqual(['in_progress', 'queued'])
    reviews.submit('sora', verdict({ verdict: 'approve', findings: [] }))
    await reviews.tick()
    expect(stateOf(second)).toBe('in_progress')
  })

  it('does not move a reviewer a second time for the next review if they are not ready after the first', async () => {
    const first = await submitted('First', 'first.ts')
    const second = await submitted('Second', 'second.ts')
    delivery.ready.add('sora')
    delivery.readyAfterRestart = false
    lock.acquire('sora') // so both are waiting when the pass first runs
    await reviews.request(first.id, 'sora', 'manual')
    await reviews.request(second.id, 'sora', 'manual')
    lock.release('sora')
    await reviews.tick()
    expect(delivery.restarts).toHaveLength(1)
    expect([stateOf(first), stateOf(second)]).toEqual(['queued', 'queued'])
    expect(delivery.delivered).toEqual([])
  })

  it('does not hand over a review that was dropped while the reviewer was being moved', async () => {
    const t = await submitted()
    delivery.ready.add('sora')
    delivery.onRestart = () =>
      fx.missions.taskAction(t.id, { action: 'request-changes', note: 'no' })
    await reviews.request(t.id, 'sora', 'manual')
    await reviews.tick()
    expect(stateOf(t)).toBe('cancelled')
    expect(delivery.delivered).toEqual([])
    expect(reviews.hasActive('sora')).toBe(false)
  })

  it('goes back to waiting, and lets go of the reviewer, if it cannot be handed over', async () => {
    const t = await submitted()
    delivery.ready.add('sora')
    delivery.failWith = 'the terminal is gone'
    await reviews.request(t.id, 'sora', 'manual')
    await reviews.tick()
    expect(stateOf(t)).toBe('queued')
    expect(lock.isHeld('sora')).toBe(false)

    delivery.failWith = null
    clock += 6_000
    await reviews.tick()
    expect(stateOf(t)).toBe('in_progress')
  })
})

describe('handing in a review', () => {
  async function reading(): Promise<Task> {
    const t = await submitted()
    delivery.ready.add('sora')
    await reviews.request(t.id, 'sora', 'manual')
    await reviews.tick()
    return t
  }

  it('keeps the verdict, the summary and each finding, and says so', async () => {
    const t = await reading()
    const review = reviews.submit('sora', verdict())
    expect(review).toMatchObject({
      state: 'submitted',
      verdict: 'request_changes',
      summary: 'Does not validate the email.',
    })
    expect(review.findings).toEqual([
      { severity: 'major', file: 'src/login.ts', line: 3, note: 'The email is not validated.' },
    ])
    expect(stateOf(t)).toBe('submitted')
    expect(fx.eventsOf('review.changed').at(-1)).toMatchObject({
      payload: { change: 'submitted', verdict: 'request_changes' },
    })
    const audit = fx.services.db
      .prepare("SELECT actor FROM audit_log WHERE action = 'review.submit'")
      .get()
    expect(audit).toEqual({ actor: 'sora' })
  })

  it('does not accept, reject or send back the task: it is advice', async () => {
    const t = await reading()
    reviews.submit('sora', verdict())
    expect(fx.missions.getTask(t.id)?.status).toBe('submitted')
  })

  it('can only be handed in by the person reading it, and only once', async () => {
    await reading()
    expect(refusal(() => reviews.submit('mika', verdict())).code).toBe('no-review')
    expect(refusal(() => reviews.submit('ren', verdict())).code).toBe('no-review')
    reviews.submit('sora', verdict())
    expect(refusal(() => reviews.submit('sora', verdict())).code).toBe('no-review')
  })

  it('refuses what is not a proper review', async () => {
    await reading()
    const escape = String.fromCharCode(27)
    for (const bad of [
      verdict({ summary: '' }),
      verdict({ summary: `a${escape}[2Jb` }),
      verdict({ verdict: 'lgtm' as never }),
      verdict({ findings: [{ severity: 'catastrophic' as never, note: 'x' }] }),
      verdict({ findings: Array.from({ length: 51 }, () => finding) }),
      verdict({ findings: [{ severity: 'nit', note: 'x', line: 0 }] }),
    ]) {
      expect(refusal(() => reviews.submit('sora', bad)).code).toBe('invalid')
    }
    expect(stateOf(fx.missions.listMissions()[0]?.tasks[0] as Task)).toBe('in_progress')
  })

  it('can be approved with nothing to report', async () => {
    await reading()
    const review = reviews.submit('sora', { verdict: 'approve', summary: 'Looks right.' })
    expect(review.findings).toEqual([])
    expect(review.verdict).toBe('approve')
  })

  it('shows the reviewer their review again when asked', async () => {
    await reading()
    expect(reviews.hasActive('sora')).toBe(true)
    expect(await reviews.current('sora')).toContain('[Shokuba review]')
    reviews.submit('sora', verdict())
    expect(reviews.hasActive('sora')).toBe(false)
    expect(await reviews.current('sora')).toBeNull()
  })
})

describe('when the work changes', () => {
  it('drops a review that has not started', async () => {
    const t = await submitted()
    await reviews.request(t.id, 'sora', 'manual')
    fx.missions.taskAction(t.id, { action: 'request-changes', note: 'no' })
    expect(stateOf(t)).toBe('cancelled')
    expect(interrupted).toEqual([])
  })

  it('drops one under way, stops the reviewer, and refuses what they hand in afterwards', async () => {
    const t = await submitted()
    delivery.ready.add('sora')
    await reviews.request(t.id, 'sora', 'manual')
    await reviews.tick()
    fx.missions.taskAction(t.id, { action: 'request-changes', note: 'no' })
    expect(stateOf(t)).toBe('cancelled')
    expect(interrupted).toEqual(['sora'])
    expect(refusal(() => reviews.submit('sora', verdict())).code).toBe('no-review')
  })

  it('leaves a review alone when the task is accepted', async () => {
    const t = await submitted()
    delivery.ready.add('sora')
    await reviews.request(t.id, 'sora', 'manual')
    await reviews.tick()
    fx.missions.taskAction(t.id, { action: 'accept' })
    expect(stateOf(t)).toBe('in_progress')
    reviews.submit('sora', verdict())
    expect(stateOf(t)).toBe('submitted')
  })

  it('says a review is out of date once the author has changed the work', async () => {
    const t = await submitted()
    delivery.ready.add('sora')
    await reviews.request(t.id, 'sora', 'manual')
    await reviews.tick()
    reviews.submit('sora', verdict())
    expect((await reviews.forTask(t.id)).outOfDate).toBe(false)

    // The author makes another commit in their own folder.
    const info = workspaces.infoFor(t.id)
    writeFileSync(join(info?.folder ?? '', 'more.ts'), 'export {}\n')
    await workspaces.commit(t)
    const later = await reviews.forTask(t.id)
    expect(later.outOfDate).toBe(true)
    expect(later.latest?.state).toBe('submitted')
  })
})

describe('asking for one automatically', () => {
  it('does it when the author submits, if the project is set up for it', async () => {
    reviews.saveSettings({ repoRoot: repo, reviewerId: 'sora', auto: true })
    const t = await submitted()
    await vi.waitFor(() => expect(stateOf(t)).toBe('queued'))
    expect(rowFor(t)).toMatchObject({ requested_by: 'auto', reviewer_id: 'sora' })
  })

  it('does not when it is switched off, or when the reviewer is the author', async () => {
    reviews.saveSettings({ repoRoot: repo, reviewerId: 'sora', auto: false })
    const off = await submitted('Off')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(rowFor(off)).toBeUndefined()

    reviews.saveSettings({ repoRoot: repo, reviewerId: 'ren', auto: true })
    const own = await submitted('Own work', 'own.ts')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(rowFor(own)).toBeUndefined()
  })
})

describe('the record of a task’s reviews', () => {
  it('lists every review of a task, oldest first, with what was found', async () => {
    const t = await submitted()
    delivery.ready.add('sora')
    await reviews.request(t.id, 'sora', 'manual')
    await reviews.tick()
    reviews.submit('sora', verdict())
    clock += 1_000
    await reviews.request(t.id, 'mika', 'manual')

    const { reviews: all, total } = reviews.history(t.id)
    expect(total).toBe(2)
    expect(all.map((r) => [r.reviewerId, r.state, r.verdict])).toEqual([
      ['sora', 'submitted', 'request_changes'],
      ['mika', 'queued', null],
    ])
    expect(all[0]?.findings).toEqual([
      { severity: 'major', file: 'src/login.ts', line: 3, note: 'The email is not validated.' },
    ])
    expect(reviews.history(t.id, 1).reviews.map((r) => r.reviewerId)).toEqual(['mika'])
    expect(reviews.history('nothing-here')).toEqual({ reviews: [], total: 0 })
  })
})

describe('what a person is told about a task', () => {
  it('has settings and no review before one is asked for', async () => {
    const t = await submitted()
    expect(await reviews.forTask(t.id)).toEqual({
      repoRoot: repo,
      settings: { repoRoot: repo, reviewerId: null, auto: false },
      reason: null,
      latest: null,
      outOfDate: false,
    })
  })

  it('says nothing about a task that was not worked on in its own folder', async () => {
    const t = fx.missions.createTask({ missionId, title: 'None', assigneeId: 'ren' })
    expect(await reviews.forTask(t.id)).toMatchObject({
      repoRoot: null,
      settings: null,
      latest: null,
    })
  })
})

describe('cleaning up', () => {
  it('removes a reading folder once the review is over, and not before', async () => {
    const t = await submitted()
    delivery.ready.add('sora')
    await reviews.request(t.id, 'sora', 'manual')
    await reviews.tick()
    expect(reviews.pendingRemoval()).toEqual([])

    reviews.submit('sora', verdict())
    const [due] = reviews.pendingRemoval()
    expect(due?.folder).toBe(delivery.restarts[0]?.cwd)
    expect(await reviews.removeFolder(due?.key ?? '')).toBe(true)
    expect(existsSync(due?.folder ?? '')).toBe(false)
    expect(reviews.pendingRemoval()).toEqual([])
    expect(await reviews.removeFolder(due?.key ?? '')).toBe(false)
  })

  it('marks a review that was being read when Shokuba stopped as not finished', async () => {
    const t = await submitted()
    delivery.ready.add('sora')
    await reviews.request(t.id, 'sora', 'manual')
    await reviews.tick()
    reviews.stop()
    reviews = build()
    reviews.start()
    expect(stateOf(t)).toBe('error')
    expect(refusal(() => reviews.submit('sora', verdict())).code).toBe('no-review')
  })
})
