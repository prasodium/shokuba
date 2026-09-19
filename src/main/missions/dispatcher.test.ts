import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mission } from '@shared/missions'
import { createLogger } from '../logging/logger'
import { createMissionFixture, type MissionFixture } from './fixtures'
import { Dispatcher, type DeliveryPort, type WorkspacePort } from './dispatcher'

/** A stand-in for the agent runtime: which agents are deliverable, and what was sent. */
class FakeDelivery implements DeliveryPort {
  readonly ready = new Set<string>()
  readonly delivered: Array<{ employeeId: string; text: string }> = []
  failWith: string | null = null

  deliveryBlocker(employeeId: string): string | null {
    return this.ready.has(employeeId) ? null : 'is not running'
  }

  async deliverPrompt(employeeId: string, text: string): Promise<void> {
    if (this.failWith) throw new Error(this.failWith)
    this.delivered.push({ employeeId, text })
  }
}

let fx: MissionFixture
let delivery: FakeDelivery
let dispatcher: Dispatcher
let mission: Mission
let clock: number

beforeEach(() => {
  fx = createMissionFixture()
  fx.addEmployee('mika')
  fx.addEmployee('ren')
  delivery = new FakeDelivery()
  clock = 1_000_000
  dispatcher = new Dispatcher({
    missions: fx.missions,
    delivery,
    events: fx.services.events,
    logger: createLogger(() => {}),
    now: () => clock,
  })
  mission = fx.missions.createMission({ title: 'M' })
})

afterEach(() => {
  dispatcher.stop()
  fx.cleanup()
})

const add = (title: string, assigneeId: string | null, extra: object = {}) =>
  fx.missions.createTask({ missionId: mission.id, title, assigneeId, ...extra })
const run = () => fx.missions.missionAction(mission.id, 'run')
const status = (id: string) => fx.missions.getTask(id)?.status

describe('Dispatcher', () => {
  it('hands a ready task to an idle assignee, and says so', async () => {
    const a = add('Write the login page', 'mika')
    delivery.ready.add('mika')
    run()
    await dispatcher.tick()

    expect(status(a.id)).toBe('in_progress')
    expect(delivery.delivered).toHaveLength(1)
    expect(delivery.delivered[0]?.employeeId).toBe('mika')
    expect(delivery.delivered[0]?.text).toContain('Write the login page')
    expect(fx.eventsOf('task.dispatched')[0]?.payload).toMatchObject({
      taskId: a.id,
      employeeId: 'mika',
      attempt: 1,
    })
  })

  it('does nothing unless the mission is running', async () => {
    add('A', 'mika')
    delivery.ready.add('mika')
    await dispatcher.tick() // draft
    expect(delivery.delivered).toEqual([])
    run()
    fx.missions.missionAction(mission.id, 'pause')
    await dispatcher.tick()
    expect(delivery.delivered).toEqual([])
  })

  it('waits for an agent that cannot safely receive input, without claiming the task', async () => {
    const a = add('A', 'mika')
    run() // mika is not in `ready`
    await dispatcher.tick()
    expect(status(a.id)).toBe('ready')
    expect(delivery.delivered).toEqual([])
  })

  it('gives an agent one task at a time', async () => {
    const first = add('first', 'mika', { priority: 'high' })
    const second = add('second', 'mika')
    delivery.ready.add('mika')
    run()
    await dispatcher.tick()
    await dispatcher.tick()
    expect(delivery.delivered.map((d) => d.text.includes('first'))).toEqual([true])
    expect(status(first.id)).toBe('in_progress')
    expect(status(second.id)).toBe('ready')
  })

  it('moves on to the next task once the first is accepted', async () => {
    const first = add('first', 'mika')
    const second = add('second', 'mika')
    delivery.ready.add('mika')
    run()
    await dispatcher.tick()
    fx.missions.agentSubmit('mika', { summary: 'ok' }, { source: 'reported' })
    fx.missions.taskAction(first.id, { action: 'accept' })
    await dispatcher.tick()
    expect(status(second.id)).toBe('in_progress')
  })

  it('serves different agents in the same pass', async () => {
    add('for mika', 'mika')
    add('for ren', 'ren')
    delivery.ready.add('mika').add('ren')
    run()
    await dispatcher.tick()
    expect(delivery.delivered.map((d) => d.employeeId).sort()).toEqual(['mika', 'ren'])
  })

  it('respects dependencies: a task waits until what it needs is accepted', async () => {
    const a = add('design', 'mika')
    const b = add('build', 'ren', { dependsOn: [a.id] })
    delivery.ready.add('mika').add('ren')
    run()
    await dispatcher.tick()
    expect(status(b.id)).toBe('pending')
    fx.missions.agentSubmit('mika', { summary: 'designed' }, { source: 'reported' })
    await dispatcher.tick()
    expect(status(b.id)).toBe('pending') // submitted is only a claim
    fx.missions.taskAction(a.id, { action: 'accept' })
    await dispatcher.tick()
    expect(status(b.id)).toBe('in_progress')
    expect(delivery.delivered.at(-1)?.text).toContain('designed')
  })

  it('undoes the claim when delivery fails, and does not hammer the agent', async () => {
    const a = add('A', 'mika')
    delivery.ready.add('mika')
    delivery.failWith = 'the terminal went away'
    run()
    await dispatcher.tick()
    expect(fx.missions.getTask(a.id)).toMatchObject({ status: 'ready', attempts: 0 })

    delivery.failWith = null
    await dispatcher.tick() // still inside the cooldown
    expect(delivery.delivered).toEqual([])

    clock += 10_000
    await dispatcher.tick()
    expect(status(a.id)).toBe('in_progress')
  })

  it('never delivers the same task twice when passes overlap', async () => {
    add('A', 'mika')
    delivery.ready.add('mika')
    run()
    await Promise.all([dispatcher.tick(), dispatcher.tick(), dispatcher.tick()])
    expect(delivery.delivered).toHaveLength(1)
  })

  it('reacts to events by itself once started', async () => {
    add('A', 'mika')
    delivery.ready.add('mika')
    dispatcher.start()
    run()
    await vi.waitFor(() => expect(delivery.delivered).toHaveLength(1))
  })

  it('blocks what an agent was doing when its process stops', async () => {
    const a = add('A', 'mika')
    delivery.ready.add('mika')
    dispatcher.start()
    run()
    await vi.waitFor(() => expect(status(a.id)).toBe('in_progress'))
    fx.services.events.publish({
      type: 'agent.stopped',
      source: 'system',
      payload: { employeeId: 'mika', exitCode: 1, signal: null },
    })
    expect(fx.missions.getTask(a.id)).toMatchObject({
      status: 'blocked',
      blockedReason: 'the agent stopped',
    })
  })

  it('stops reacting once stopped', async () => {
    add('A', 'mika')
    delivery.ready.add('mika')
    dispatcher.start()
    dispatcher.stop()
    run()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(delivery.delivered).toEqual([])
  })
})

describe('while the circuit breaker limits an agent', () => {
  it('holds its tasks back, gives them to others, and hands them over once it is lifted', async () => {
    const limited = new Set(['mika'])
    const gated = new Dispatcher({
      missions: fx.missions,
      delivery,
      events: fx.services.events,
      logger: createLogger(() => {}),
      now: () => clock,
      allowsTasks: (id) => !limited.has(id),
    })
    const forMika = add('for mika', 'mika')
    const forRen = add('for ren', 'ren')
    delivery.ready.add('mika').add('ren')
    run()

    await gated.tick()
    expect(status(forMika.id)).toBe('ready')
    expect(status(forRen.id)).toBe('in_progress')

    limited.delete('mika')
    await gated.tick()
    expect(status(forMika.id)).toBe('in_progress')
    gated.stop()
  })
})

describe('giving each task its own working folder', () => {
  /** A runtime that remembers where each agent works, and what happened, in order. */
  class Located extends FakeDelivery implements DeliveryPort {
    readonly where = new Map<string, string>([['mika', '/home/mika']])
    readonly log: string[] = []
    restartFails: string | null = null
    /** What the task's status was at the moment of each restart. */
    readonly statusAtRestart: string[] = []
    task: string | null = null

    cwdOf(id: string): string | undefined {
      return this.where.get(id)
    }
    async restartIn(id: string, cwd: string): Promise<void> {
      this.log.push(`restart ${cwd}`)
      if (this.task) this.statusAtRestart.push(status(this.task) ?? '?')
      if (this.restartFails) throw new Error(this.restartFails)
      this.where.set(id, cwd)
    }
    override async deliverPrompt(id: string, text: string): Promise<void> {
      this.log.push('deliver')
      await super.deliverPrompt(id, text)
    }
  }

  let located: Located
  let isolated: Map<string, { cwd: string; note: string } | null>
  let gated: Dispatcher

  const workspaces: WorkspacePort = {
    prepare: async (task) => isolated.get(task.id) ?? null,
    home: async () => '/home/mika',
  }

  beforeEach(() => {
    located = new Located()
    isolated = new Map()
    gated = new Dispatcher({
      missions: fx.missions,
      delivery: located,
      events: fx.services.events,
      logger: createLogger(() => {}),
      now: () => clock,
      workspaces,
    })
  })
  afterEach(() => gated.stop())

  it('restarts the agent in the task’s folder before claiming the task, then hands it over with a note', async () => {
    const t = add('Build it', 'mika')
    located.task = t.id
    located.ready.add('mika')
    isolated.set(t.id, { cwd: '/work/task-1', note: 'Your working folder is /work/task-1.' })
    run()
    await gated.tick()

    expect(located.log).toEqual(['restart /work/task-1', 'deliver'])
    // The restart happened while the task was still unclaimed, so it cannot look like the agent died mid-task.
    expect(located.statusAtRestart).toEqual(['ready'])
    expect(status(t.id)).toBe('in_progress')
    const text = located.delivered[0]?.text ?? ''
    expect(text).toContain('Build it')
    expect(text.endsWith('Your working folder is /work/task-1.')).toBe(true)
  })

  it('does not restart an agent that is already in the right folder', async () => {
    const t = add('Retry', 'mika')
    located.ready.add('mika')
    located.where.set('mika', '/work/task-1')
    isolated.set(t.id, { cwd: '/work/task-1', note: 'note' })
    run()
    await gated.tick()
    expect(located.log).toEqual(['deliver'])
    expect(status(t.id)).toBe('in_progress')
  })

  it('puts an agent back in its own folder for a task that is not isolated', async () => {
    const t = add('No repo', 'mika')
    located.ready.add('mika')
    located.where.set('mika', '/work/old-task') // left over from an earlier task
    run()
    await gated.tick()
    expect(located.log).toEqual(['restart /home/mika', 'deliver'])
    expect(located.delivered[0]?.text).toBe(fx.missions.briefing(t.id))
  })

  it('leaves an agent that is already home alone for a task that is not isolated', async () => {
    add('No repo', 'mika')
    located.ready.add('mika')
    run()
    await gated.tick()
    expect(located.log).toEqual(['deliver'])
  })

  it('does not claim the task if the agent cannot be restarted, and tries again later', async () => {
    const t = add('Build it', 'mika')
    located.ready.add('mika')
    located.restartFails = 'the agent did not come back ready in time'
    isolated.set(t.id, { cwd: '/work/task-1', note: 'note' })
    run()
    await gated.tick()
    expect(status(t.id)).toBe('ready')
    expect(located.delivered).toEqual([])

    located.restartFails = null
    await gated.tick() // still cooling down
    expect(status(t.id)).toBe('ready')
    clock += 6_000
    await gated.tick()
    expect(status(t.id)).toBe('in_progress')
  })

  it('leaves the task unclaimed if the agent is not ready for input after its restart', async () => {
    const t = add('Build it', 'mika')
    located.ready.add('mika')
    isolated.set(t.id, { cwd: '/work/task-1', note: 'note' })
    // The restart happens, but the agent then reports it is busy.
    const restart = located.restartIn.bind(located)
    located.restartIn = async (id, cwd) => {
      await restart(id, cwd)
      located.ready.delete(id)
    }
    run()
    await gated.tick()
    expect(status(t.id)).toBe('ready')
    expect(located.delivered).toEqual([])
  })

  it('behaves exactly as before when no workspaces are configured', async () => {
    const plain = new Dispatcher({
      missions: fx.missions,
      delivery: located,
      events: fx.services.events,
      logger: createLogger(() => {}),
      now: () => clock,
    })
    const t = add('Plain', 'mika')
    located.ready.add('mika')
    located.where.set('mika', '/somewhere/else')
    run()
    await plain.tick()
    expect(located.log).toEqual(['deliver'])
    expect(status(t.id)).toBe('in_progress')
    plain.stop()
  })
})
