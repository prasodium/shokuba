import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises as fsp,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '@shared/missions'
import type { Review } from '@shared/reviews'
import type { CheckRun } from '@shared/verification'
import { GitService } from '../git/service'
import { createLogger } from '../logging/logger'
import { createMissionFixture, type MissionFixture } from '../missions/fixtures'
import { removeTree, toPlatformId } from '../platform'
import { WorkspaceService, type WorkspaceEmployee } from '../workspaces/service'
import { hasControlCharacters, utc } from './collect'
import { scrubPaths } from './markdown'
import { EvidenceError, EvidenceService, plainPath } from './service'

let dir: string
let repo: string
let dest: string
let noConfig: string
let fx: MissionFixture
let git: GitService
let workspaces: WorkspaceService
let evidence: EvidenceService
let missionId: string
let runs: CheckRun[]
let reviews: Review[]

// Secret-shaped text is built at runtime so no token-like literal sits in the source tree.
const secret = (): string => 'sk-' + 'ant-' + 'a'.repeat(30)

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
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'shokuba-evidence-')))
  noConfig = join(dir, 'no-git-config')
  writeFileSync(noConfig, '')
  repo = join(dir, 'my-project')
  dest = join(dir, 'exports')
  mkdirSync(repo)
  mkdirSync(dest)
  sh(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  sh(repo, 'add', '-A')
  sh(repo, 'commit', '-qm', 'base')

  fx = createMissionFixture()
  fx.addEmployee('ren', 'Ren', 'Engineer')
  fx.addEmployee('sora', 'Sora', 'QA')
  const people = new Map<string, WorkspaceEmployee>([
    ['ren', { id: 'ren', name: 'Ren', workingDirectory: repo }],
    ['sora', { id: 'sora', name: 'Sora', workingDirectory: repo }],
  ])
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
  runs = []
  reviews = []
  evidence = build()
  missionId = fx.missions.createMission({ title: 'Ship login' }).id
  fx.missions.missionAction(missionId, 'run')
})

afterEach(async () => {
  vi.restoreAllMocks()
  fx.cleanup()
  await removeTree(dir)
})

function build(
  overrides: Partial<ConstructorParameters<typeof EvidenceService>[0]> = {},
): EvidenceService {
  return new EvidenceService({
    missions: fx.missions,
    employees: {
      get: (id) => {
        const found = fx.directory().find((e) => e.id === id)
        return found && { id, name: found.name, role: found.role }
      },
    },
    events: fx.services.events.log,
    workspaces,
    git,
    verification: { history: () => ({ runs, total: runs.length }) },
    reviews: { history: () => ({ reviews, total: reviews.length }) },
    audit: fx.services.audit,
    platform: toPlatformId(),
    shokubaVersion: '1.2.3',
    logger: createLogger(() => {}),
    now: () => new Date('2026-03-04T05:06:07.000Z'),
    ...overrides,
  })
}

/** The agent's turn: it works in its own folder, then submits. */
async function submitted(
  title = 'Build the login',
  patch: { description?: string; summary?: string; file?: string; text?: string } = {},
): Promise<Task> {
  const t = fx.missions.createTask({
    missionId,
    title,
    description: patch.description ?? 'Validate the email.',
    assigneeId: 'ren',
  })
  fx.missions.markDispatched(t.id)
  const prepared = await workspaces.prepare(t)
  writeFileSync(join(prepared?.cwd ?? '', patch.file ?? 'login.ts'), patch.text ?? 'export {}\n')
  await workspaces.commit(t)
  fx.missions.agentSubmit('ren', { summary: patch.summary ?? 'Did it.' }, { source: 'reported' })
  return fx.missions.getTask(t.id) as Task
}

/** The person accepts it, as the app does: merge first, then the decision. */
async function accept(t: Task): Promise<void> {
  await workspaces.mergeForAccept(t)
  fx.missions.taskAction(t.id, { action: 'accept' })
}

function checkRun(commit: string, patch: Partial<CheckRun> = {}): CheckRun {
  return {
    id: 'run-' + (runs.length + 1),
    taskId: 'x',
    commit,
    trigger: 'auto',
    state: 'failed',
    startedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: '2026-01-01T00:00:09.000Z',
    note: null,
    results: [
      {
        position: 0,
        kind: 'check',
        name: 'Lint',
        command: 'npm run lint',
        state: 'failed',
        exitCode: 1,
        durationMs: 1200,
        output: 'src/login.ts:1 unused\n',
        truncated: false,
      },
    ],
    ...patch,
  }
}

const review = (commit: string, patch: Partial<Review> = {}): Review => ({
  id: 'rev-' + (reviews.length + 1),
  taskId: 'x',
  reviewerId: 'sora',
  commit,
  state: 'submitted',
  verdict: 'request_changes',
  summary: 'Does not validate the email.',
  findings: [{ severity: 'major', file: 'login.ts', line: 1, note: 'No validation.' }],
  requestedBy: 'manual',
  createdAt: '2026-01-01T00:00:10.000Z',
  startedAt: '2026-01-01T00:00:11.000Z',
  submittedAt: '2026-01-01T00:00:20.000Z',
  note: null,
  ...patch,
})

/** What is left of a report once code spans and fenced blocks, where nothing is interpreted, are taken out. */
const outsideCode = (report: string): string =>
  report
    .replace(/^(`{3,})[^\n]*\n[\s\S]*?\n\1$/gm, '')
    .replace(/(`+)[^`\n]([^\n]*?[^`\n])?\1(?!`)/g, '')

const packFolder = (result: { folder: string }): string => result.folder
const read = (folder: string, file: string): string => readFileSync(join(folder, file), 'utf8')

describe('what is gathered about a task', () => {
  it('has what was asked, the agent’s own account, the commits, the files and the diff', async () => {
    const t = await submitted('Build the login', {
      description: 'Validate the email and show errors.',
      summary: 'All done, honestly.',
      text: 'export const login = () => true\n',
    })
    const pack = await evidence.collect(t.id)
    expect(pack).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-03-04T05:06:07.000Z',
      shokubaVersion: '1.2.3',
      mission: { title: 'Ship login' },
      task: {
        title: 'Build the login',
        description: 'Validate the email and show errors.',
        agentSummary: 'All done, honestly.',
        status: 'submitted',
        assignee: { name: 'Ren', role: 'Engineer' },
      },
      outcome: { accepted: false, acceptedAt: null, acceptedBy: null, sentBack: 0 },
    })
    expect(pack.work).toMatchObject({
      isolated: true,
      project: 'my-project',
      branch: `shokuba/task/${t.id}`,
      state: 'active',
      mergeCommit: null,
      files: [{ path: 'login.ts', added: 1, deleted: 0, binary: false }],
    })
    expect(pack.work.commits.map((c) => [c.author, c.subject])).toEqual([
      ['Ren', 'Task: Build the login'],
    ])
    expect(pack.work.finalCommit).toBe(sh(repo, 'rev-parse', `shokuba/task/${t.id}`))
    expect(pack.work.diff).toMatchObject({
      file: 'changes.diff',
      truncated: false,
      secretSignals: [],
    })
  })

  it('says who accepted it and when, once it is accepted, and that it was sent back first', async () => {
    const t = await submitted()
    fx.missions.taskAction(t.id, { action: 'request-changes', note: 'Not yet.' })
    fx.missions.markDispatched(t.id)
    fx.missions.agentSubmit('ren', { summary: 'Again.' }, { source: 'reported' })
    await accept(t)
    const pack = await evidence.collect(t.id)
    expect(pack.task.status).toBe('done')
    expect(pack.outcome).toMatchObject({ accepted: true, acceptedBy: 'person', sentBack: 1 })
    expect(pack.outcome.acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(pack.work).toMatchObject({ state: 'merged' })
    expect(pack.work.mergeCommit).toBe(sh(repo, 'rev-parse', `shokuba/mission/${missionId}`))
    // The diff and the commits are still there afterwards: the branch stays.
    expect(pack.work.files.map((f) => f.path)).toEqual(['login.ts'])
    const lines = pack.timeline.map((e) => e.text)
    expect(lines).toContain('Task created')
    expect(lines).toContain('Status submitted → done: accepted')
    expect(lines.some((l) => l.startsWith('Work saved as commit'))).toBe(true)
    const accepted = pack.timeline.find((e) => e.text === 'Status submitted → done: accepted')
    expect(accepted?.source).toBe('user')
  })

  it('says whether the checks and the review were of the commit the work ended at', async () => {
    const t = await submitted()
    const finalCommit = sh(repo, 'rev-parse', `shokuba/task/${t.id}`)
    const passing = checkRun('x', { state: 'passed' }).results.map((r) => ({
      ...r,
      state: 'passed' as const,
      exitCode: 0,
    }))
    runs = [checkRun('e'.repeat(40)), checkRun(finalCommit, { state: 'passed', results: passing })]
    reviews = [review('e'.repeat(40)), review(finalCommit, { verdict: 'approve', findings: [] })]
    const pack = await evidence.collect(t.id)
    expect(pack.checks.runs.map((r) => r.onFinalCommit)).toEqual([false, true])
    expect(pack.reviews.reviews.map((r) => r.onFinalCommit)).toEqual([false, true])
    expect(pack.reviews.reviews[1]?.reviewer).toEqual({ id: 'sora', name: 'Sora' })
    // Judged by the newest of each.
    expect(pack.checks.headline).toBe('The one check passed on the final commit.')
    expect(pack.reviews.headline).toBe(
      'The reviewer approved the work on the final commit, with no findings. There were 2 reviews in all.',
    )
  })

  it('names a reviewer who no longer exists as such, and does not fail', async () => {
    const t = await submitted()
    reviews = [review(sh(repo, 'rev-parse', `shokuba/task/${t.id}`), { reviewerId: 'gone' })]
    const pack = await evidence.collect(t.id)
    expect(pack.reviews.reviews[0]?.reviewer).toEqual({ id: 'gone', name: 'a removed employee' })
  })

  it('keeps no full path anywhere, only the project’s folder name', async () => {
    const t = await submitted()
    runs = [checkRun(sh(repo, 'rev-parse', `shokuba/task/${t.id}`))]
    const collected = JSON.stringify(await evidence.collect(t.id))
    expect(collected).not.toContain(dir)
    expect(collected).not.toContain(tmpdir())
    expect(collected).toContain('my-project')
  })

  it('does not include the diff in the data, only a record of it', async () => {
    const t = await submitted('Build it', { text: 'const marker = "UNIQUE-DIFF-MARKER"\n' })
    expect(JSON.stringify(await evidence.collect(t.id))).not.toContain('UNIQUE-DIFF-MARKER')
  })

  it('refuses a task that does not exist', async () => {
    await expect(evidence.collect('nothing-here')).rejects.toThrow(EvidenceError)
  })

  it('says why there is no diff for a task that had no folder of its own, and for one never handed out', async () => {
    const off = new WorkspaceService({
      db: fx.services.db,
      events: fx.services.events,
      missions: fx.missions,
      employees: { get: () => ({ id: 'ren', name: 'Ren', workingDirectory: repo }) },
      git: undefined,
      unavailable: 'isolation is switched off',
      platform: toPlatformId(),
      logger: createLogger(() => {}),
    })
    const plain = fx.missions.createTask({ missionId, title: 'Plain', assigneeId: 'ren' })
    await off.prepare(plain)
    const service = new EvidenceService({ ...buildDeps(off) })
    const pack = await service.collect(plain.id)
    expect(pack.work.isolated).toBe(false)
    expect(pack.work.problem).toContain('isolation is switched off')
    expect(pack.work.diff).toBeNull()

    const waiting = fx.missions.createTask({ missionId, title: 'Waiting' })
    expect((await evidence.collect(waiting.id)).work.problem).toBe(
      'The task was never handed to an agent.',
    )
  })

  function buildDeps(space: WorkspaceService) {
    return {
      missions: fx.missions,
      employees: { get: () => ({ id: 'ren', name: 'Ren', role: 'Engineer' }) },
      events: fx.services.events.log,
      workspaces: space,
      git: undefined,
      verification: { history: () => ({ runs: [], total: 0 }) },
      reviews: { history: () => ({ reviews: [], total: 0 }) },
      audit: fx.services.audit,
      platform: toPlatformId(),
      shokubaVersion: '1',
      logger: createLogger(() => {}),
    }
  }
})

describe('a diff that holds control characters', () => {
  const ESC = String.fromCharCode(0x1b)

  it('is noticed, and said, and kept exactly as it is', async () => {
    const t = await submitted('Colours', {
      file: 'colours.txt',
      text: `red ${ESC}[31mred${ESC}[0m\n`,
    })
    const result = await evidence.export(t.id, dest)
    expect(JSON.parse(read(result.folder, 'evidence.json')).work.diff.hasControlCharacters).toBe(
      true,
    )
    expect(read(result.folder, 'changes.diff')).toContain(ESC)
    expect(read(result.folder, 'report.md')).not.toContain(ESC)
    expect(result.warnings.some((w) => w.includes('control characters'))).toBe(true)
  })

  it('is not reported for ordinary text, tabs, or Windows line endings', async () => {
    const t = await submitted('Plain', { text: 'a\tb\r\nc\n' })
    const result = await evidence.export(t.id, dest)
    expect(JSON.parse(read(result.folder, 'evidence.json')).work.diff.hasControlCharacters).toBe(
      false,
    )
    expect(result.warnings.some((w) => w.includes('control characters'))).toBe(false)
  })

  it('is told apart from ordinary text by one function', () => {
    expect(hasControlCharacters('plain\ttext\r\n')).toBe(false)
    expect(hasControlCharacters(`a${ESC}b`)).toBe(true)
    expect(hasControlCharacters(`a${String.fromCharCode(0)}b`)).toBe(true)
    expect(hasControlCharacters(`a${String.fromCharCode(0x7f)}b`)).toBe(true)
    expect(hasControlCharacters('日本語 — “quoted”')).toBe(false)
  })
})

describe('a task with a great many events', () => {
  it('is read to the end, a page at a time, keeping the newest', async () => {
    const t = await submitted()
    const asked: number[] = []
    const page = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        seq: from + i,
        id: `e${from + i}`,
        ts: '2026-01-01T00:00:00.000Z',
        source: 'system',
        type: 'task.created',
        payload: { taskId: t.id, missionId, title: 'x' },
      }))
    const many = build({
      events: {
        list: (options) => {
          asked.push(options.afterSeq ?? 0)
          return (options.afterSeq ?? 0) === 0 ? (page(1, 1000) as never) : (page(1001, 3) as never)
        },
      },
    })
    const pack = await many.collect(t.id)
    expect(asked).toEqual([0, 1000])
    expect(pack.timelineTruncated).toBe(true)
    expect(pack.timeline.at(-1)?.seq).toBe(1003)
  })
})

describe('paths in what Shokuba says about a task', () => {
  it('are replaced, wherever they sit in a sentence', () => {
    expect(scrubPaths('Could not run Git: spawn /usr/local/bin/git ENOENT')).toBe(
      'Could not run Git: spawn [path] ENOENT',
    )
    expect(scrubPaths('cannot open "C:\\Users\\someone\\repo" now')).toBe(
      'cannot open "[path]" now',
    )
    expect(scrubPaths('\\\\server\\share\\repo is gone')).toBe('[path] is gone')
    expect(scrubPaths('/home/u/project failed (/tmp/x)')).toBe('[path] failed ([path])')
  })

  it('leave ordinary sentences, and words with a slash in them, alone', () => {
    const plain = 'That folder is not inside a Git repository; try and/or the other one, 1/2 done'
    expect(scrubPaths(plain)).toBe(plain)
    expect(scrubPaths('isolation is switched off')).toBe('isolation is switched off')
  })

  it('are not in the reason a task had no folder of its own', async () => {
    const off = new WorkspaceService({
      db: fx.services.db,
      events: fx.services.events,
      missions: fx.missions,
      employees: { get: () => ({ id: 'ren', name: 'Ren', workingDirectory: repo }) },
      git: undefined,
      unavailable: `Could not run Git: spawn ${repo}/git ENOENT`,
      platform: toPlatformId(),
      logger: createLogger(() => {}),
    })
    const plain = fx.missions.createTask({ missionId, title: 'Plain', assigneeId: 'ren' })
    await off.prepare(plain)
    const service = build({ workspaces: off, git: undefined })
    const pack = await service.collect(plain.id)
    expect(pack.work.problem).toContain('[path]')
    expect(JSON.stringify(pack)).not.toContain(dir)
  })
})

describe('times', () => {
  it('are UTC everywhere, including the time a commit was made, whatever timezone made it', async () => {
    const t = await submitted()
    const pack = await evidence.collect(t.id)
    expect(pack.work.commits[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('turns a time with an offset into the same moment in UTC, and says so when it cannot read one', () => {
    expect(utc('2026-09-20T02:36:28+05:30')).toBe('2026-09-19T21:06:28.000Z')
    expect(utc('2026-01-01T00:00:00-08:00')).toBe('2026-01-01T08:00:00.000Z')
    expect(utc('not a time')).toBe('unknown')
    expect(utc('')).toBe('unknown')
  })
})

describe('secrets', () => {
  it('are removed from what people and agents wrote, in the report and the data', async () => {
    const t = await submitted('Use the key', {
      description: `Call the API with ${secret()} please.`,
      summary: `I used ${secret()} to test.`,
    })
    reviews = [
      review(sh(repo, 'rev-parse', `shokuba/task/${t.id}`), {
        summary: `Do not commit ${secret()}.`,
      }),
    ]
    const result = await evidence.export(t.id, dest)
    const folder = packFolder(result)
    for (const file of ['report.md', 'evidence.json']) {
      expect(read(folder, file)).not.toContain(secret())
      expect(read(folder, file)).toContain('[REDACTED:anthropic-key]')
    }
  })

  it('are left in the diff, which is the code exactly as written, and reported without being repeated', async () => {
    const t = await submitted('Add a config', {
      file: 'config.ts',
      text: `export const key = '${secret()}'\n`,
    })
    const result = await evidence.export(t.id, dest)
    const folder = packFolder(result)
    expect(read(folder, 'changes.diff')).toContain(secret()) // exactly as Git produced it
    expect(read(folder, 'report.md')).not.toContain(secret())
    expect(read(folder, 'evidence.json')).not.toContain(secret())
    expect(read(folder, 'report.md')).toContain('Check before sharing')
    expect(JSON.parse(read(folder, 'evidence.json')).work.diff.secretSignals).toEqual([
      { kind: 'anthropic-key', count: 1 },
    ])
    expect(result.warnings.some((w) => w.includes('look like a secret (anthropic-key)'))).toBe(true)
    expect(result.warnings.join(' ')).not.toContain(secret())
  })

  it('are removed again from the output of a check, even if it was not when it was kept', async () => {
    const t = await submitted()
    const run = checkRun(sh(repo, 'rev-parse', `shokuba/task/${t.id}`))
    run.results[0]!.output = `token leaked: ${secret()}\n`
    runs = [run]
    const folder = packFolder(await evidence.export(t.id, dest))
    expect(read(folder, 'checks/run-1-step-1-lint.log')).not.toContain(secret())
    expect(read(folder, 'checks/run-1-step-1-lint.log')).toContain('[REDACTED:anthropic-key]')
  })
})

describe('writing the pack', () => {
  it('makes a new folder in the chosen place with the report, the data, the diff and a log per step', async () => {
    const t = await submitted('Build the login')
    runs = [checkRun(sh(repo, 'rev-parse', `shokuba/task/${t.id}`))]
    const result = await evidence.export(t.id, dest)
    expect(result.folder).toBe(
      join(dest, `shokuba-evidence-build-the-login-${t.id.slice(0, 8).toLowerCase()}`),
    )
    expect(result.files.sort()).toEqual([
      'changes.diff',
      'checks/run-1-step-1-lint.log',
      'evidence.json',
      'report.md',
    ])
    expect(readdirSync(dest)).toHaveLength(1)
    const report = read(result.folder, 'report.md')
    expect(report).toContain('# Evidence pack')
    expect(report).toContain('`Build the login`')
    expect(report).toContain('[checks/run-1-step-1-lint.log](checks/run-1-step-1-lint.log)')
    expect(read(result.folder, 'checks/run-1-step-1-lint.log')).toBe('src/login.ts:1 unused\n')
    expect(read(result.folder, 'changes.diff')).toContain('+export {}')
    expect(JSON.parse(read(result.folder, 'evidence.json')).task.title).toBe('Build the login')
  })

  it('records that it was exported, without saying where', async () => {
    const t = await submitted()
    await evidence.export(t.id, dest)
    const row = fx.services.db
      .prepare("SELECT actor, target, detail FROM audit_log WHERE action = 'evidence.export'")
      .get() as { actor: string; target: string; detail: string }
    expect(row.actor).toBe('user')
    expect(row.target).toBe(t.id)
    expect(row.detail).not.toContain(dir)
    expect(JSON.parse(row.detail)).toMatchObject({ files: 3 })
  })

  it('never overwrites: a second export goes in a second folder and the first is untouched', async () => {
    const t = await submitted()
    const first = await evidence.export(t.id, dest)
    const before = read(first.folder, 'report.md')
    writeFileSync(join(first.folder, 'notes.txt'), 'mine')
    const second = await evidence.export(t.id, dest)
    expect(second.folder).toBe(`${first.folder}-2`)
    expect(read(first.folder, 'report.md')).toBe(before)
    expect(read(first.folder, 'notes.txt')).toBe('mine')
    expect((await evidence.export(t.id, dest)).folder).toBe(`${first.folder}-3`)
  })

  it('leaves anything else in the chosen place alone', async () => {
    const t = await submitted()
    writeFileSync(join(dest, 'keep.txt'), 'keep')
    mkdirSync(join(dest, 'other'))
    await evidence.export(t.id, dest)
    expect(read(dest, 'keep.txt')).toBe('keep')
    expect(existsSync(join(dest, 'other'))).toBe(true)
  })

  it.skipIf(toPlatformId() === 'win32')(
    'does not follow a link that is in the way, and writes nowhere else',
    async () => {
      const t = await submitted()
      const elsewhere = join(dir, 'elsewhere')
      mkdirSync(elsewhere)
      const name = `shokuba-evidence-build-the-login-${t.id.slice(0, 8).toLowerCase()}`
      symlinkSync(elsewhere, join(dest, name))
      const result = await evidence.export(t.id, dest)
      expect(result.folder).toBe(join(dest, `${name}-2`))
      expect(readdirSync(elsewhere)).toEqual([])
    },
  )

  it.skipIf(toPlatformId() === 'win32')(
    'does not write through a link someone plants in the new folder, and keeps nothing',
    async () => {
      const t = await submitted()
      const target = join(dir, 'precious.txt')
      writeFileSync(target, 'do not touch')
      const real = fsp.writeFile
      vi.spyOn(fsp, 'writeFile').mockImplementation(async (...args) => {
        // Between the folder being made and the file being written, a link appears in its place.
        if (String(args[0]).endsWith('evidence.json')) symlinkSync(target, String(args[0]))
        return real(...(args as Parameters<typeof real>))
      })
      await expect(evidence.export(t.id, dest)).rejects.toThrow('nothing was kept')
      expect(readFileSync(target, 'utf8')).toBe('do not touch')
      expect(readdirSync(dest)).toEqual([])
    },
  )

  it('needs a real folder that exists, given as a full path', async () => {
    const t = await submitted()
    await expect(evidence.export(t.id, 'exports')).rejects.toThrow('Choose a folder')
    await expect(evidence.export(t.id, join(dir, 'nowhere'))).rejects.toThrow('not a folder')
    writeFileSync(join(dir, 'file.txt'), 'x')
    await expect(evidence.export(t.id, join(dir, 'file.txt'))).rejects.toThrow('not a folder')
    await expect(evidence.export('nothing-here', dest)).rejects.toThrow(EvidenceError)
    expect(readdirSync(dest)).toEqual([])
  })

  it('leaves nothing behind if it cannot finish, rather than a pack that looks whole', async () => {
    const t = await submitted()
    runs = [checkRun(sh(repo, 'rev-parse', `shokuba/task/${t.id}`))]
    const real = fsp.writeFile
    let calls = 0
    vi.spyOn(fsp, 'writeFile').mockImplementation(async (...args) => {
      calls += 1
      if (calls === 3) throw new Error('disk full')
      return real(...(args as Parameters<typeof real>))
    })
    await expect(evidence.export(t.id, dest)).rejects.toThrow('nothing was kept')
    expect(readdirSync(dest)).toEqual([])
  })

  it('makes each file name itself, from a plain version of what a step is called', async () => {
    const t = await submitted()
    const run = checkRun(sh(repo, 'rev-parse', `shokuba/task/${t.id}`))
    run.results[0]!.name = '../../../etc/passwd; rm -rf ~'
    runs = [run]
    const result = await evidence.export(t.id, dest)
    expect(result.files).toContain('checks/run-1-step-1-etc-passwd-rm-rf.log')
    // Everything written is inside the pack's folder.
    const inside = (folder: string): string[] =>
      readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? inside(join(folder, entry.name)) : [join(folder, entry.name)],
      )
    expect(inside(dest).every((path) => path.startsWith(result.folder))).toBe(true)
    expect(existsSync(join(dir, 'etc'))).toBe(false)
  })
})

describe('text that someone else wrote', () => {
  it('is shown inertly in the report, wherever it came from', async () => {
    const hostile =
      '# Fake heading [click](https://evil.invalid/x) ![p](https://evil.invalid/p.png) <img src=https://evil.invalid/i.png>'
    const t = await submitted(hostile, { description: hostile, summary: hostile })
    reviews = [
      review(sh(repo, 'rev-parse', `shokuba/task/${t.id}`), {
        summary: hostile,
        findings: [{ severity: 'major', file: hostile, line: 1, note: hostile }],
      }),
    ]
    const run = checkRun(sh(repo, 'rev-parse', `shokuba/task/${t.id}`))
    run.results[0]!.name = hostile
    run.results[0]!.command = hostile
    runs = [run]
    const folder = packFolder(await evidence.export(t.id, dest))
    const rest = outsideCode(read(folder, 'report.md'))
    expect(rest).not.toContain('evil.invalid')
    expect(rest).not.toContain('<img')
    expect(rest).not.toContain('Fake heading')
    expect(existsSync(join(folder, 'report.md'))).toBe(true)
  })
})

describe('the names a pack is allowed to write', () => {
  it('accepts the plain ones Shokuba makes, in a folder or not', () => {
    expect(plainPath('report.md')).toEqual(['report.md'])
    expect(plainPath('checks/run-1-step-2-test.log')).toEqual(['checks', 'run-1-step-2-test.log'])
  })

  it('refuses anything that could point somewhere else', () => {
    for (const bad of [
      '../report.md',
      'checks/../../x',
      '/etc/passwd',
      'C:/Windows/x',
      'C:\\Windows\\x',
      'a//b',
      '',
      '.hidden',
      'checks/',
      'a b.md',
      'a..b',
      'nul\u0000.md',
      '~/x',
    ]) {
      expect(() => plainPath(bad), JSON.stringify(bad)).toThrow('refusing to write')
    }
  })
})
