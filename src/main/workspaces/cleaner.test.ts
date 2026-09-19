import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '@shared/missions'
import { createLogger } from '../logging/logger'
import { createMissionFixture, type MissionFixture } from '../missions/fixtures'
import { toPlatformId } from '../platform'
import { WorkspaceCleaner, type Removals } from './cleaner'

/** A stand-in for the workspace service: which folders are due, and which were removed. */
class FakeRemovals implements Removals {
  due: Array<{ task: Task; folder: string }> = []
  readonly removed: string[] = []
  failFor = new Set<string>()
  pendingRemoval(): Array<{ task: Task; folder: string }> {
    return this.due.filter((entry) => !this.removed.includes(entry.folder))
  }
  async removeFolder(task: Task): Promise<boolean> {
    const entry = this.due.find((d) => d.task.id === task.id)
    if (!entry) return false
    if (this.failFor.has(entry.folder)) throw new Error('locked')
    this.removed.push(entry.folder)
    return true
  }
}

let fx: MissionFixture
let removals: FakeRemovals
let occupied: string[]
let cleaner: WorkspaceCleaner
let task: Task

const isWindows = toPlatformId() === 'win32'
const folder = (name: string): string =>
  isWindows ? `C:\\data\\worktrees\\${name}` : `/data/worktrees/${name}`
const inside = (name: string, sub: string): string =>
  isWindows ? `${folder(name)}\\${sub}` : `${folder(name)}/${sub}`

beforeEach(() => {
  fx = createMissionFixture()
  fx.addEmployee('ren')
  const mission = fx.missions.createMission({ title: 'M' })
  task = fx.missions.createTask({ missionId: mission.id, title: 'T', assigneeId: 'ren' })
  removals = new FakeRemovals()
  occupied = []
  cleaner = new WorkspaceCleaner({
    workspaces: removals,
    events: fx.services.events,
    inUse: () => occupied,
    platform: toPlatformId(),
    logger: createLogger(() => {}),
  })
})

afterEach(() => {
  cleaner.stop()
  fx.cleanup()
})

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))
const due = (name: string): void => {
  // One task per folder, as in real life.
  removals.due.push({ task: { ...task, id: `task-${name}` }, folder: folder(name) })
}

describe('WorkspaceCleaner', () => {
  it('removes a finished task’s folder when no agent is working in it', async () => {
    due('a')
    expect(await cleaner.sweep()).toBe(1)
    expect(removals.removed).toEqual([folder('a')])
  })

  it('leaves a folder alone while an agent is working in it, or in a subfolder of it', async () => {
    due('a')
    occupied = [folder('a')]
    expect(await cleaner.sweep()).toBe(0)
    occupied = [inside('a', 'packages')]
    expect(await cleaner.sweep()).toBe(0)
    expect(removals.removed).toEqual([])
  })

  it('does not mistake a folder with a similar name for the one in use', async () => {
    due('task-1')
    occupied = [folder('task-10')]
    expect(await cleaner.sweep()).toBe(1)
  })

  it('removes it once the agent has moved on', async () => {
    due('a')
    occupied = [folder('a')]
    cleaner.start()
    await settle()
    expect(removals.removed).toEqual([])

    // The agent is started afresh somewhere else: the event that says so triggers a sweep.
    occupied = [folder('b')]
    fx.services.events.publish({
      type: 'agent.started',
      source: 'system',
      payload: { employeeId: 'ren' },
    })
    await settle()
    expect(removals.removed).toEqual([folder('a')])
  })

  it('removes it when the agent stops', async () => {
    due('a')
    occupied = [folder('a')]
    cleaner.start()
    await settle()
    occupied = []
    fx.services.events.publish({
      type: 'agent.stopped',
      source: 'system',
      payload: { employeeId: 'ren', exitCode: 0, signal: null },
    })
    await settle()
    expect(removals.removed).toEqual([folder('a')])
  })

  it('removes it when its task is finished', async () => {
    cleaner.start()
    await settle()
    due('a')
    fx.services.events.publish({
      type: 'task.status.changed',
      source: 'user',
      payload: { taskId: task.id, missionId: task.missionId, from: 'submitted', to: 'done' },
    })
    await settle()
    expect(removals.removed).toEqual([folder('a')])
  })

  it('clears whatever earlier runs left behind as soon as it starts', async () => {
    due('a')
    due('b')
    cleaner.start()
    await settle()
    expect(removals.removed.sort()).toEqual([folder('a'), folder('b')])
  })

  it('does nothing on events that cannot free a folder', async () => {
    cleaner.start()
    await settle()
    due('a')
    fx.services.events.publish({
      type: 'agent.ready',
      source: 'reported',
      payload: { employeeId: 'ren' },
    })
    await settle()
    expect(removals.removed).toEqual([])
  })

  it('carries on with the others when one folder cannot be removed, and tries it again later', async () => {
    due('a')
    due('b')
    removals.failFor.add(folder('a'))
    expect(await cleaner.sweep()).toBe(1)
    expect(removals.removed).toEqual([folder('b')])
    removals.failFor.clear()
    expect(await cleaner.sweep()).toBe(1)
    expect(removals.removed).toEqual([folder('b'), folder('a')])
  })

  it('does not run two passes at once', async () => {
    due('a')
    const first = cleaner.sweep()
    const second = await cleaner.sweep() // asked while the first is under way
    await first
    expect(second).toBe(0)
    expect(removals.removed).toEqual([folder('a')])
  })

  it('stops reacting once stopped', async () => {
    cleaner.start()
    cleaner.stop()
    due('a')
    fx.services.events.publish({
      type: 'agent.stopped',
      source: 'system',
      payload: { employeeId: 'ren', exitCode: 0, signal: null },
    })
    await settle()
    expect(removals.removed).toEqual([])
  })

  it.skipIf(isWindows)(
    'recognises an agent in a folder that is spelled through a symbolic link',
    async () => {
      // Shokuba stores the folder one way (here, through a link); the runtime reports the agent's
      // folder resolved. They are the same place, and the agent is in it.
      const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'shokuba-cleaner-')))
      try {
        const actual = join(base, 'actual')
        const alias = join(base, 'alias')
        mkdirSync(actual)
        symlinkSync(actual, alias)
        removals.due.push({ task: { ...task, id: 'task-linked' }, folder: alias })
        occupied = [actual]
        expect(await cleaner.sweep()).toBe(0)
        expect(removals.removed).toEqual([])
        // Once the agent has left, it goes.
        occupied = []
        expect(await cleaner.sweep()).toBe(1)
      } finally {
        rmSync(base, { recursive: true, force: true })
      }
    },
  )
})
