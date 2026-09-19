import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mission } from '@shared/missions'
import { createLogger } from '../logging/logger'
import { createMissionFixture, type MissionFixture } from './fixtures'
import { Dispatcher, type DeliveryPort } from './dispatcher'

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
