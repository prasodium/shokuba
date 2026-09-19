import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '@shared/missions'
import type { CheckSettingsSave } from '@shared/verification'
import type { GitService } from '../git/service'
import { createLogger } from '../logging/logger'
import { createMissionFixture, type MissionFixture } from '../missions/fixtures'
import { toPlatformId } from '../platform'
import type { StepOutcome, StepSpec, runStep } from './runner'
import { CheckError, CheckSettingsStore } from './settings'
import { VerificationService } from './service'

const REPO = '/work/my-project'
const COMMIT = 'a'.repeat(40)

let fx: MissionFixture
let settings: CheckSettingsStore
let service: VerificationService
let missionId: string

/** What the fake runner was asked, and a way to hold a step until the test lets it finish. */
interface Call {
  spec: StepSpec
  finish(outcome?: Partial<StepOutcome>): void
  signal: AbortSignal | undefined
}
let calls: Call[]
let auto: boolean
let outcomes: Map<string, Partial<StepOutcome>>
let folders: Map<string, string>
let commitWorks: boolean
let isolation: Map<string, string>
/** Where each task's working folder really is, so the service finds it on disk. */
let root: string

const ok = (patch: Partial<StepOutcome> = {}): StepOutcome => ({
  state: 'passed',
  exitCode: 0,
  durationMs: 12,
  output: 'fine\n',
  truncated: false,
  ...patch,
})

const fakeRun: typeof runStep = (spec, _options, signal) =>
  new Promise<StepOutcome>((resolve) => {
    const call: Call = {
      spec,
      signal,
      finish: (outcome = {}) => resolve(ok(outcome)),
    }
    calls.push(call)
    signal?.addEventListener('abort', () => resolve(ok({ state: 'cancelled', exitCode: null })))
    if (auto) {
      const planned = [...outcomes].find(([needle]) => spec.command.includes(needle))?.[1]
      // Finish on the next turn so the test can still see it was called.
      setTimeout(() => call.finish(planned), 0)
    }
  })

const git = {
  resolve: async () => COMMIT,
  head: async () => ({ commit: COMMIT, branch: 'main' }),
  topLevelNames: async () => new Set(['package.json', 'package-lock.json']),
  showFile: async () => JSON.stringify({ scripts: { test: 'jest', lint: 'eslint' } }),
} as unknown as GitService

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'shokuba-verification-')))
  fx = createMissionFixture()
  fx.addEmployee('ren', 'Ren')
  settings = new CheckSettingsStore({ db: fx.services.db })
  calls = []
  auto = true
  outcomes = new Map()
  folders = new Map()
  commitWorks = true
  isolation = new Map()
  service = build()
  service.start()
  missionId = fx.missions.createMission({ title: 'M' }).id
})

afterEach(() => {
  service.stop()
  fx.cleanup()
  rmSync(root, { recursive: true, force: true })
})

function build(): VerificationService {
  return new VerificationService({
    db: fx.services.db,
    events: fx.services.events,
    audit: fx.services.audit,
    settings,
    git,
    missions: fx.missions,
    workspaces: {
      infoFor: (taskId) => {
        const folder = folders.get(taskId)
        return folder ? { repoRoot: REPO, folder, branch: `shokuba/task/${taskId}` } : undefined
      },
      isolationReason: (taskId) => isolation.get(taskId) ?? null,
      commit: async () => commitWorks,
    },
    platform: toPlatformId(),
    env: {},
    logger: createLogger(() => {}),
    run: fakeRun,
  })
}

const setUp = (patch: Partial<CheckSettingsSave> = {}) =>
  settings.save({
    repoRoot: REPO,
    acknowledged: true,
    steps: [
      { kind: 'setup', name: 'Install', command: 'npm ci' },
      { kind: 'check', name: 'Test', command: 'npm test', timeoutSeconds: 90 },
      { kind: 'check', name: 'Lint', command: 'npm run lint' },
    ],
    ...patch,
  })

/** A task the agent has worked on in its own folder. */
function task(title = 'Build it'): Task {
  const t = fx.missions.createTask({ missionId, title, assigneeId: 'ren' })
  const folder = join(root, t.id)
  mkdirSync(folder)
  folders.set(t.id, folder)
  return t
}

function status(t: Task, to: string, from = 'in_progress'): void {
  fx.services.events.publish({
    type: 'task.status.changed',
    source: 'system',
    missionId: t.missionId,
    taskId: t.id,
    payload: { taskId: t.id, missionId: t.missionId, from: from as never, to: to as never },
  })
}
const submitted = (t: Task): void => status(t, 'submitted')

const runOf = async (t: Task) => (await service.forTask(t.id)).latest
const done = (t: Task) =>
  vi.waitFor(async () => {
    const run = await runOf(t)
    expect(run).not.toBeNull()
    expect(run?.state).not.toBe('running')
  })

describe('running checks when an agent submits', () => {
  it('runs the person’s steps in order, on the task’s own folder, and keeps what happened', async () => {
    setUp()
    const t = task()
    submitted(t)
    await done(t)

    expect(calls.map((c) => c.spec.command)).toEqual(['npm ci', 'npm test', 'npm run lint'])
    expect(calls.every((c) => c.spec.cwd === join(root, t.id))).toBe(true)
    expect(calls.map((c) => c.spec.timeoutMs)).toEqual([600_000, 90_000, 600_000])

    const run = await runOf(t)
    expect(run).toMatchObject({ state: 'passed', trigger: 'auto', commit: COMMIT, note: null })
    expect(run?.results.map((r) => [r.name, r.state, r.exitCode])).toEqual([
      ['Install', 'passed', 0],
      ['Test', 'passed', 0],
      ['Lint', 'passed', 0],
    ])
    expect(run?.results[0]).toMatchObject({ kind: 'setup', command: 'npm ci', output: 'fine\n' })
  })

  it('says what it is doing in the event log, and audits the commands it ran', async () => {
    setUp()
    const t = task()
    submitted(t)
    await done(t)

    const changes = fx
      .eventsOf('verification.changed')
      .map((e) => (e.type === 'verification.changed' ? e.payload.change : ''))
    expect(changes[0]).toBe('started')
    expect(changes.at(-1)).toBe('finished')
    expect(changes.filter((c) => c === 'step')).toHaveLength(3)

    const audit = fx.services.db
      .prepare("SELECT actor, target, detail FROM audit_log WHERE action = 'checks.run'")
      .get() as { actor: string; target: string; detail: string }
    expect(audit).toMatchObject({ actor: 'system', target: t.id })
    expect(JSON.parse(audit.detail)).toEqual({
      commit: COMMIT,
      trigger: 'auto',
      commands: ['npm ci', 'npm test', 'npm run lint'],
    })
  })

  it('does nothing until checks are set up and switched on', async () => {
    const t = task()
    submitted(t)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls).toEqual([])
    setUp({ acknowledged: false })
    submitted(t)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls).toEqual([])
    expect(await runOf(t)).toBeNull()
  })

  it('does nothing for a task that was not worked on in its own folder', async () => {
    setUp()
    const t = fx.missions.createTask({ missionId, title: 'Not isolated', assigneeId: 'ren' })
    isolation.set(t.id, 'That folder is not inside a Git repository')
    submitted(t)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls).toEqual([])
    expect((await service.forTask(t.id)).reason).toBe(
      'It was not worked on in its own folder (That folder is not inside a Git repository), so its work cannot be checked.',
    )
  })

  it('runs only once for a task, however many times it is reported', async () => {
    setUp()
    const t = task()
    submitted(t)
    submitted(t)
    submitted(t)
    await done(t)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls).toHaveLength(3) // one run: three steps
  })

  it('saves the agent’s work first, so the checks run on a commit; and does not run if it cannot', async () => {
    setUp()
    commitWorks = false
    const t = task()
    submitted(t)
    await done(t)
    expect(calls).toEqual([])
    expect(await runOf(t)).toMatchObject({ state: 'error', results: [] })
    expect((await runOf(t))?.note).toContain('could not be saved as a commit')
  })
})

describe('when a step does not pass', () => {
  it('carries on with the other checks, and the run has failed', async () => {
    setUp()
    outcomes.set('npm test', { state: 'failed', exitCode: 1, output: '1 test failed\n' })
    const t = task()
    submitted(t)
    await done(t)
    const run = await runOf(t)
    expect(run?.state).toBe('failed')
    expect(run?.results.map((r) => r.state)).toEqual(['passed', 'failed', 'passed'])
    expect(run?.results[1]).toMatchObject({ exitCode: 1, output: '1 test failed\n' })
  })

  it('does not run the checks if a setup step failed, and says why', async () => {
    setUp()
    outcomes.set('npm ci', { state: 'failed', exitCode: 1, output: 'install failed\n' })
    const t = task()
    submitted(t)
    await done(t)
    const run = await runOf(t)
    expect(run).toMatchObject({
      state: 'failed',
      note: 'A setup step failed, so the checks could not run.',
    })
    expect(run?.results.map((r) => r.state)).toEqual(['failed', 'skipped', 'skipped'])
    expect(calls.map((c) => c.spec.command)).toEqual(['npm ci'])
  })

  it('counts a step that ran out of time as a failure', async () => {
    setUp()
    outcomes.set('npm test', { state: 'timeout', exitCode: null })
    const t = task()
    submitted(t)
    await done(t)
    const run = await runOf(t)
    expect(run?.state).toBe('failed')
    expect(run?.results[1]?.state).toBe('timeout')
  })
})

describe('one run at a time', () => {
  it('does not start a second task’s checks until the first has finished', async () => {
    setUp()
    auto = false
    const first = task('First')
    const second = task('Second')
    submitted(first)
    submitted(second)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]?.spec.cwd).toContain(first.id)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls).toHaveLength(1) // the second waits its turn

    // Let the first run finish, step by step.
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() =>
        expect(calls.filter((c) => c.spec.cwd.includes(first.id))).toHaveLength(i + 1),
      )
      calls[i]?.finish()
    }
    await vi.waitFor(() => expect(calls.some((c) => c.spec.cwd.includes(second.id))).toBe(true))
  })

  it('says which folder is in use, so it is not cleaned up from under a run', async () => {
    setUp()
    auto = false
    const t = task()
    expect(service.activeFolders()).toEqual([])
    submitted(t)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(service.activeFolders()).toEqual([join(root, t.id)])
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(calls).toHaveLength(i + 1))
      calls[i]?.finish()
    }
    await done(t)
    expect(service.activeFolders()).toEqual([])
  })
})

describe('when the work being checked goes away', () => {
  it('stops a run when the task is sent back, and marks what did not run', async () => {
    setUp()
    auto = false
    const t = task()
    submitted(t)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    status(t, 'changes_requested', 'submitted')
    expect(calls[0]?.signal?.aborted).toBe(true)
    await done(t)
    const run = await runOf(t)
    expect(run?.state).toBe('cancelled')
    expect(run?.results.map((r) => r.state)).toEqual(['cancelled', 'cancelled', 'cancelled'])
  })

  it('drops a run that has not started yet', async () => {
    setUp()
    auto = false
    const first = task('First')
    const second = task('Second')
    submitted(first)
    submitted(second)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    status(second, 'cancelled', 'submitted')
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(calls).toHaveLength(i + 1))
      calls[i]?.finish()
    }
    await done(first)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls.some((c) => c.spec.cwd.includes(second.id))).toBe(false)
    expect(await runOf(second)).toBeNull()
  })

  it('lets a run finish when the task is accepted while it is under way', async () => {
    setUp()
    auto = false
    const t = task()
    submitted(t)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    status(t, 'done', 'submitted')
    expect(calls[0]?.signal?.aborted).toBe(false)
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(calls).toHaveLength(i + 1))
      calls[i]?.finish()
    }
    await done(t)
    expect((await runOf(t))?.state).toBe('passed')
  })
})

describe('asking for the checks again', () => {
  it('runs them on a submitted task, as a manual run', async () => {
    const t = task()
    fx.missions.missionAction(missionId, 'run')
    fx.missions.markDispatched(t.id)
    fx.missions.agentSubmit('ren', { summary: 'done' }, { source: 'reported' })
    setUp() // set up after the submission, so nothing has run on its own yet
    service.runNow(t.id)
    await done(t)
    expect((await runOf(t))?.trigger).toBe('manual')
  })

  it('is refused while the agent is still working, without checks set up, or when a run is under way', async () => {
    const t = task()
    fx.missions.missionAction(missionId, 'run')
    fx.missions.markDispatched(t.id)
    expect(() => service.runNow(t.id)).toThrow(/once the agent has submitted/)
    fx.missions.agentSubmit('ren', { summary: 'done' }, { source: 'reported' })
    expect(() => service.runNow(t.id)).toThrow(/Set up and switch on checks/)
    setUp()
    auto = false
    service.runNow(t.id)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(() => service.runNow(t.id)).toThrow(CheckError)
    expect(() => service.runNow(t.id)).toThrow(/already running/)
    calls[0]?.signal?.dispatchEvent(new Event('abort'))
  })

  it('is refused for a task with no working folder', () => {
    setUp()
    const t = fx.missions.createTask({ missionId, title: 'No folder', assigneeId: 'ren' })
    expect(() => service.runNow(t.id)).toThrow(/no working folder/)
  })
})

describe('what is kept', () => {
  it('is the steps as they ran, whatever the settings say afterwards', async () => {
    setUp()
    const t = task()
    submitted(t)
    await done(t)
    setUp({ steps: [{ kind: 'check', name: 'Something else', command: 'make' }] })
    const run = await runOf(t)
    expect(run?.results.map((r) => r.name)).toEqual(['Install', 'Test', 'Lint'])
  })

  it('is the newest run for a task, with its results', async () => {
    setUp()
    const t = task()
    fx.missions.missionAction(missionId, 'run')
    fx.missions.markDispatched(t.id)
    fx.missions.agentSubmit('ren', { summary: 'done' }, { source: 'reported' }) // runs by itself
    await done(t)
    const first = await runOf(t)
    expect(first?.trigger).toBe('auto')

    service.runNow(t.id)
    await vi.waitFor(async () => expect((await runOf(t))?.id).not.toBe(first?.id))
    await done(t)
    const second = await runOf(t)
    expect(second?.trigger).toBe('manual')
    expect(second?.results).toHaveLength(3)
  })

  it('marks a run that was under way when Shokuba stopped as not finished', async () => {
    setUp()
    auto = false
    const t = task()
    submitted(t)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    // Shokuba goes away mid-run; a new one starts over the same database.
    service.stop()
    service = build()
    service.start()
    const run = await runOf(t)
    expect(run).toMatchObject({ state: 'error', note: 'Shokuba stopped while this was running' })
  })
})

describe('what a person is told about a task', () => {
  it('says nothing for a task that has not been handed out', async () => {
    const t = fx.missions.createTask({ missionId, title: 'Not yet', assigneeId: 'ren' })
    expect(await service.forTask(t.id)).toEqual({
      repoRoot: null,
      repoName: null,
      configured: false,
      reason: null,
      latest: null,
    })
  })

  it('explains why nothing is being checked, in each case', async () => {
    const t = task()
    expect((await service.forTask(t.id)).reason).toBe('No checks are set up for this project.')
    setUp({ acknowledged: false })
    expect((await service.forTask(t.id)).reason).toBe(
      'Checks are set up for this project but not switched on.',
    )
    setUp({ steps: [{ kind: 'check', name: 'Test', command: 'x', enabled: false }] })
    expect((await service.forTask(t.id)).reason).toBe('This project has no enabled check.')
    setUp()
    expect(await service.forTask(t.id)).toMatchObject({
      configured: true,
      reason: null,
      repoName: 'my-project',
    })
  })
})

describe('suggesting checks', () => {
  it('reads the project’s own files and proposes steps, without saving anything', async () => {
    const suggestions = await service.suggest(REPO)
    expect(suggestions.map((s) => s.command)).toEqual(['npm ci', 'npm run lint', 'npm test'])
    expect(settings.get(REPO).steps).toEqual([])
  })
})
