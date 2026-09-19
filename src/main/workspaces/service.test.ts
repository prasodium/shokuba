import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '@shared/missions'
import { GitService } from '../git/service'
import { createLogger } from '../logging/logger'
import { createMissionFixture, type MissionFixture } from '../missions/fixtures'
import { toPlatformId } from '../platform'
import { WorkspaceService, type WorkspaceEmployee } from './service'

let dir: string
let repo: string
let noConfig: string
let fx: MissionFixture
let git: GitService
let people: Map<string, WorkspaceEmployee>
let workspaces: WorkspaceService
let missionId: string

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

const write = (folder: string, name: string, text: string): void =>
  writeFileSync(join(folder, name), text)

beforeEach(async () => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'shokuba-workspaces-')))
  noConfig = join(dir, 'no-git-config')
  writeFileSync(noConfig, '')
  repo = join(dir, 'repo')
  mkdirSync(repo)
  sh(repo, 'init', '-q', '-b', 'main')
  write(repo, 'a.txt', 'one\ntwo\nthree\n')
  sh(repo, 'add', '-A')
  sh(repo, 'commit', '-qm', 'base')

  fx = createMissionFixture()
  fx.addEmployee('ren', 'Ren', 'Engineer')
  fx.addEmployee('sora', 'Sora', 'QA')
  people = new Map([
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
  workspaces = build(git)
  missionId = fx.missions.createMission({ title: 'Ship login' }).id
})

afterEach(() => {
  fx.cleanup()
  rmSync(dir, { recursive: true, force: true })
})

function build(service: GitService | undefined, unavailable?: string): WorkspaceService {
  return new WorkspaceService({
    db: fx.services.db,
    events: fx.services.events,
    missions: fx.missions,
    employees: { get: (id) => people.get(id) },
    git: service,
    ...(unavailable && { unavailable }),
    platform: toPlatformId(),
    logger: createLogger(() => {}),
  })
}

const task = (title: string, assignee = 'ren'): Task =>
  fx.missions.createTask({ missionId, title, assigneeId: assignee })

/** The agent's work: edit a file in the task's folder, then submit (which commits it). */
async function work(t: Task, file: string, text: string, folder?: string): Promise<string> {
  const prepared = await workspaces.prepare(t)
  if (!prepared) throw new Error('expected an isolated workspace')
  const cwd = folder ?? prepared.cwd
  write(cwd, file, text)
  await workspaces.commit(t)
  return cwd
}

describe('preparing a task', () => {
  it('gives it its own branch and folder, cut from the mission branch, leaving your checkout alone', async () => {
    const t = task('Build it')
    const prepared = await workspaces.prepare(t)
    expect(prepared).not.toBeNull()
    expect(prepared?.cwd.startsWith(git.worktreesRoot)).toBe(true)
    expect(readFileSync(join(prepared?.cwd ?? '', 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
    expect(sh(prepared?.cwd ?? '', 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      `shokuba/task/${t.id}`,
    )
    expect(sh(repo, 'status', '--short')).toBe('')
    expect(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(sh(repo, 'branch', '--list', `shokuba/mission/${missionId}`)).toContain(missionId)
  })

  it('tells the agent where it is working and what Shokuba does for it', async () => {
    const prepared = await workspaces.prepare(task('Build it'))
    expect(prepared?.note).toContain('isolated in its own Git branch')
    expect(prepared?.note).toContain(prepared?.cwd ?? 'x')
    expect(prepared?.note).toContain('saves your changes as a commit')
    expect(prepared?.note).toContain('not yet committed in the main checkout are not in it')
  })

  it('gives tasks of one mission the same mission branch, and separate folders', async () => {
    const a = await workspaces.prepare(task('A'))
    const b = await workspaces.prepare(task('B', 'sora'))
    expect(a?.cwd).not.toBe(b?.cwd)
    expect(sh(repo, 'branch', '--list', 'shokuba/mission/*').split('\n')).toHaveLength(1)
  })

  it('records it, and says so in the event log', async () => {
    const t = task('Build it')
    await workspaces.prepare(t)
    const created = fx.eventsOf('workspace.changed')[0]
    expect(created).toMatchObject({
      source: 'system',
      payload: { taskId: t.id, change: 'created', branch: `shokuba/task/${t.id}` },
    })
  })

  it('reuses the folder when the same task is prepared again, so the agent keeps its work', async () => {
    const t = task('Build it')
    const first = await workspaces.prepare(t)
    write(first?.cwd ?? '', 'draft.txt', 'half done\n')
    const again = await workspaces.prepare(t)
    expect(again?.cwd).toBe(first?.cwd)
    expect(existsSync(join(again?.cwd ?? '', 'draft.txt'))).toBe(true)
    expect(
      fx
        .eventsOf('workspace.changed')
        .filter((e) => e.type === 'workspace.changed' && e.payload.change === 'created'),
    ).toHaveLength(1)
  })

  it('brings the folder back on its branch if it was removed', async () => {
    const t = task('Build it')
    const cwd = await work(t, 'saved.txt', 'kept\n')
    await git.removeWorktree(repo, cwd)
    expect(existsSync(cwd)).toBe(false)
    const back = await workspaces.prepare(t)
    expect(back?.cwd).toBe(cwd)
    expect(readFileSync(join(cwd, 'saved.txt'), 'utf8')).toBe('kept\n')
  })

  it('keeps an employee who works in a subfolder working in that subfolder', async () => {
    mkdirSync(join(repo, 'packages', 'api'), { recursive: true })
    write(join(repo, 'packages', 'api'), 'index.ts', 'x\n')
    sh(repo, 'add', '-A')
    sh(repo, 'commit', '-qm', 'api')
    people.set('ren', { id: 'ren', name: 'Ren', workingDirectory: join(repo, 'packages', 'api') })
    const prepared = await workspaces.prepare(task('In a package'))
    expect(prepared?.cwd.endsWith(join('packages', 'api'))).toBe(true)
    expect(existsSync(join(prepared?.cwd ?? '', 'index.ts'))).toBe(true)
  })

  it('starts from the last commit, not from uncommitted changes in your checkout', async () => {
    write(repo, 'a.txt', 'edited but not committed\n')
    const prepared = await workspaces.prepare(task('Build it'))
    expect(readFileSync(join(prepared?.cwd ?? '', 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('edited but not committed\n')
  })
})

describe('when a task cannot be isolated', () => {
  const reasonFor = async (t: Task): Promise<string | null> => {
    const changes = await workspaces.changes(t.id)
    return changes.isolated ? null : changes.reason
  }

  it('runs it as before, and says the folder is not a repository', async () => {
    const plain = join(dir, 'plain')
    mkdirSync(plain)
    people.set('ren', { id: 'ren', name: 'Ren', workingDirectory: plain })
    const t = task('No repo')
    expect(await workspaces.prepare(t)).toBeNull()
    expect(await reasonFor(t)).toBe('That folder is not inside a Git repository')
    expect(fx.eventsOf('workspace.changed').at(-1)).toMatchObject({
      payload: { change: 'unavailable', reason: 'That folder is not inside a Git repository' },
    })
  })

  it('says so when the repository has no commits yet', async () => {
    const empty = join(dir, 'empty')
    mkdirSync(empty)
    sh(empty, 'init', '-q', '-b', 'main')
    people.set('ren', { id: 'ren', name: 'Ren', workingDirectory: empty })
    const t = task('No commits')
    expect(await workspaces.prepare(t)).toBeNull()
    expect(await reasonFor(t)).toBe('This repository has no commits yet')
  })

  it('says so when Git cannot be used at all', async () => {
    workspaces = build(undefined, 'Git 2.30 is too old: Shokuba needs 2.40 or newer.')
    const t = task('No git')
    expect(await workspaces.prepare(t)).toBeNull()
    expect(await reasonFor(t)).toBe('Git 2.30 is too old: Shokuba needs 2.40 or newer.')
  })

  it('does nothing else for such a task: no branch, no commit, no merge', async () => {
    workspaces = build(undefined, 'no git')
    const t = task('No git')
    await workspaces.prepare(t)
    await workspaces.commit(t)
    expect(await workspaces.mergeForAccept(t)).toEqual({ kind: 'not-isolated' })
    expect(sh(repo, 'branch', '--list', 'shokuba/*')).toBe('')
  })

  it('does not break a task over a Git problem: it becomes "not isolated" with a reason', async () => {
    // A folder that has vanished is a problem Git reports; the task must still go ahead.
    people.set('ren', { id: 'ren', name: 'Ren', workingDirectory: join(dir, 'vanished') })
    const t = task('Vanished')
    await expect(workspaces.prepare(t)).resolves.toBeNull()
    expect(await reasonFor(t)).toBeTruthy()
  })

  it('has nothing to say about a task that has not been handed out', async () => {
    expect(await workspaces.changes(task('Not yet').id)).toEqual({ isolated: false, reason: null })
  })
})

describe('when the agent submits', () => {
  it('saves its work as a commit by the employee, never by you', async () => {
    const t = task('Build it')
    const cwd = await work(t, 'login.ts', 'export {}\n')
    expect(sh(cwd, 'log', '-1', '--format=%an|%ae|%s')).toBe(
      'Ren|shokuba@localhost.invalid|Task: Build it',
    )
    expect(fx.eventsOf('workspace.changed').at(-1)).toMatchObject({
      payload: { change: 'committed' },
    })
  })

  it('is fine when there was nothing to save', async () => {
    const t = task('Read only')
    await workspaces.prepare(t)
    await expect(workspaces.commit(t)).resolves.toBeUndefined()
    const changes = await workspaces.changes(t.id)
    expect(changes).toMatchObject({ isolated: true, files: [], state: 'active' })
  })

  it('never fails the task over Git: a problem becomes a note the person sees', async () => {
    const t = task('Build it')
    const cwd = await work(t, 'a.txt', 'one\nTWO\nthree\n')
    await git.removeWorktree(repo, cwd) // pulled out from under the agent
    await expect(workspaces.commit(t)).resolves.toBeUndefined()
    const changes = await workspaces.changes(t.id)
    expect(changes).toMatchObject({ isolated: true })
    expect(changes.isolated && changes.note).toContain('could not save')
  })
})

describe('reviewing what a task changed', () => {
  it('shows the files and the diff, and only that task’s own changes', async () => {
    const t = task('Build it')
    await work(t, 'a.txt', 'one\nTWO\nthree\n')
    const other = task('Other', 'sora')
    await work(other, 'b.txt', 'other\n')
    const changes = await workspaces.changes(t.id)
    expect(changes.isolated).toBe(true)
    if (!changes.isolated) return
    expect(changes.files).toEqual([{ path: 'a.txt', added: 1, deleted: 1, binary: false }])
    expect(changes.diff).toContain('+TWO')
    expect(changes.diff).not.toContain('other')
    expect(changes.branch).toBe(`shokuba/task/${t.id}`)
    expect(changes.truncated).toBe(false)
  })
})

describe('accepting a task', () => {
  it('merges its work into the mission branch, and leaves your branch and checkout alone', async () => {
    const t = task('Build it')
    await work(t, 'a.txt', 'one\nTWO\nthree\n')
    const mainBefore = sh(repo, 'rev-parse', 'main')
    expect(await workspaces.mergeForAccept(t)).toEqual({ kind: 'merged' })
    expect(sh(repo, 'show', `shokuba/mission/${missionId}:a.txt`)).toBe('one\nTWO\nthree')
    expect(sh(repo, 'rev-parse', 'main')).toBe(mainBefore)
    expect(sh(repo, 'status', '--short')).toBe('')
    expect(fx.eventsOf('workspace.changed').at(-1)).toMatchObject({ payload: { change: 'merged' } })
  })

  it('lets a later task start from what was accepted before it', async () => {
    const first = task('First')
    await work(first, 'a.txt', 'one\nFIRST\nthree\n')
    await workspaces.mergeForAccept(first)
    const second = task('Second', 'sora')
    const prepared = await workspaces.prepare(second)
    expect(readFileSync(join(prepared?.cwd ?? '', 'a.txt'), 'utf8')).toBe('one\nFIRST\nthree\n')
  })

  it('still shows a merged task’s changes afterwards', async () => {
    const t = task('Build it')
    await work(t, 'a.txt', 'one\nTWO\nthree\n')
    await workspaces.mergeForAccept(t)
    const changes = await workspaces.changes(t.id)
    expect(changes).toMatchObject({ isolated: true, state: 'merged' })
    expect(changes.isolated && changes.files.map((f) => f.path)).toEqual(['a.txt'])
  })

  it('reports a conflict by file, and changes nothing', async () => {
    const first = task('First')
    await work(first, 'a.txt', 'one\nFIRST\nthree\n')
    const second = task('Second', 'sora')
    await work(second, 'a.txt', 'one\nSECOND\nthree\n')
    await workspaces.mergeForAccept(first)
    const tip = sh(repo, 'rev-parse', `shokuba/mission/${missionId}`)
    const outcome = await workspaces.mergeForAccept(second)
    expect(outcome).toEqual({
      kind: 'conflict',
      files: ['a.txt'],
      missionBranch: `shokuba/mission/${missionId}`,
    })
    expect(sh(repo, 'rev-parse', `shokuba/mission/${missionId}`)).toBe(tip)
    expect(fx.eventsOf('workspace.changed').at(-1)).toMatchObject({
      payload: { change: 'conflict', files: ['a.txt'] },
    })
  })

  it('takes a conflicting task once the agent has merged the mission branch and resolved it', async () => {
    const first = task('First')
    await work(first, 'a.txt', 'one\nFIRST\nthree\n')
    const second = task('Second', 'sora')
    const cwd = await work(second, 'a.txt', 'one\nSECOND\nthree\n')
    await workspaces.mergeForAccept(first)
    expect((await workspaces.mergeForAccept(second)).kind).toBe('conflict')

    // What the agent is told to do: merge the mission branch, resolve, and submit again.
    try {
      sh(cwd, 'merge', '--no-edit', `shokuba/mission/${missionId}`)
    } catch {
      /* the conflict is expected */
    }
    write(cwd, 'a.txt', 'one\nFIRST and SECOND\nthree\n')
    sh(cwd, 'add', '-A')
    sh(cwd, 'commit', '-qm', 'resolve')
    await workspaces.commit(second)
    expect(await workspaces.mergeForAccept(second)).toEqual({ kind: 'merged' })
    expect(sh(repo, 'show', `shokuba/mission/${missionId}:a.txt`)).toBe(
      'one\nFIRST and SECOND\nthree',
    )
  })

  it('also takes work the agent added after submitting', async () => {
    const t = task('Build it')
    const cwd = await work(t, 'a.txt', 'one\nTWO\nthree\n')
    write(cwd, 'later.txt', 'added after submit\n')
    expect(await workspaces.mergeForAccept(t)).toEqual({ kind: 'merged' })
    expect(sh(repo, 'show', `shokuba/mission/${missionId}:later.txt`)).toBe('added after submit')
  })

  it('says a task with no changes is already up to date', async () => {
    const t = task('Read only')
    await workspaces.prepare(t)
    expect(await workspaces.mergeForAccept(t)).toEqual({ kind: 'up-to-date' })
  })
})
