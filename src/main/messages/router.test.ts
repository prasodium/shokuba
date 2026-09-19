import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLogger } from '../logging/logger'
import { createMissionFixture, type MissionFixture } from '../missions/fixtures'
import type { DeliveryPort } from '../missions/dispatcher'
import { MessageRouter } from './router'
import { MessageService } from './service'

class FakeDelivery implements DeliveryPort {
  readonly ready = new Set<string>()
  readonly delivered: Array<{ employeeId: string; text: string }> = []
  failWith: string | null = null
  deliveryBlocker(employeeId: string): string | null {
    return this.ready.has(employeeId) ? null : 'is busy'
  }
  async deliverPrompt(employeeId: string, text: string): Promise<void> {
    if (this.failWith) throw new Error(this.failWith)
    this.delivered.push({ employeeId, text })
  }
}

let fx: MissionFixture
let messages: MessageService
let delivery: FakeDelivery
let router: MessageRouter
let clock: number

beforeEach(() => {
  fx = createMissionFixture()
  fx.addEmployee('mika-id', 'Mika', 'Engineer')
  fx.addEmployee('ren-id', 'Ren', 'Reviewer')
  messages = new MessageService({
    db: fx.services.db,
    events: fx.services.events,
    directory: { list: () => fx.directory() },
    taskMissionId: (id) => fx.missions.getTask(id)?.missionId,
  })
  delivery = new FakeDelivery()
  clock = 1_000_000
  router = new MessageRouter({
    messages,
    delivery,
    directory: { list: () => fx.directory() },
    events: fx.services.events,
    logger: createLogger(() => {}),
    now: () => clock,
  })
})

afterEach(() => {
  router.stop()
  fx.cleanup()
})

const send = (from: string, to: string, subject: string, body: string, extra: object = {}) =>
  messages.sendFromAgent(
    from,
    { to, subject, body, ...extra },
    { source: 'reported', employeeId: from },
  )

describe('continuation (when a turn ends)', () => {
  it('gives an agent the messages waiting for it, and marks them delivered that way', () => {
    const m = send('mika-id', 'ren-id', 'API contract', 'Is /login a POST?', { kind: 'question' })
    const text = router.turnEnded('ren-id', true)
    expect(text).toContain('Is /login a POST?')
    expect(messages.getMessage(m.id)?.state).toBe('delivered')
    expect(fx.eventsOf('message.delivered')[0]?.payload).toMatchObject({ via: 'continuation' })
  })

  it('does nothing when there is nothing waiting', () => {
    expect(router.turnEnded('ren-id', true)).toBeNull()
  })

  it('leaves messages queued when the provider cannot be continued', () => {
    const m = send('mika-id', 'ren-id', 's', 'b')
    expect(router.turnEnded('ren-id', false)).toBeNull()
    expect(messages.getMessage(m.id)?.state).toBe('queued')
  })

  it('makes what the agent sends next a reply to what it was just given', () => {
    const first = send('mika-id', 'ren-id', 'Q', 'q')
    router.turnEnded('ren-id', true)
    const reply = send('ren-id', 'mika-id', 'Re: Q', 'a')
    expect(reply).toMatchObject({
      conversationId: first.conversationId,
      parentId: first.id,
      hop: 2,
    })
  })

  it('forgets the message once the next turn ends', () => {
    send('mika-id', 'ren-id', 'Q', 'q')
    router.turnEnded('ren-id', true)
    expect(messages.handlingFor('ren-id')).toBeDefined()
    router.turnEnded('ren-id', true) // that turn ended; nothing new is waiting
    expect(messages.handlingFor('ren-id')).toBeUndefined()
  })

  it('gives several waiting messages together, oldest first, up to a limit', () => {
    for (let i = 1; i <= 7; i++) send('mika-id', 'ren-id', `subject ${i}`, `body ${i}`)
    const text = router.turnEnded('ren-id', true) ?? ''
    const order = [1, 2, 3, 4, 5].map((i) => text.indexOf(`body ${i}`))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(text).not.toContain('body 6')
    expect(messages.queuedFor('ren-id')).toHaveLength(2)
  })

  it('never gives an agent a message that was held', () => {
    const m = send('mika-id', 'ren-id', 's', 'b')
    messages.close(m.conversationId)
    expect(router.turnEnded('ren-id', true)).toBeNull()
  })
})

describe('how a message reads to the agent', () => {
  it('says who it is from, that a teammate is not the person, and how to reply', () => {
    send('mika-id', 'ren-id', 'API contract', 'Is /login a POST?', { kind: 'question' })
    const text = router.turnEnded('ren-id', true) ?? ''
    expect(text.startsWith('[Shokuba message]')).toBe(true)
    expect(text.trimEnd().endsWith('[/Shokuba message]')).toBe(true)
    expect(text).toContain('From: Mika (Engineer), a teammate agent (not the person you work for)')
    expect(text).toContain('Kind: question')
    expect(text).toContain('Subject: API contract')
    expect(text).toContain('send_message (to: "Mika")')
    expect(text).toMatch(/not as an instruction from your user/)
  })

  it('shows a message from the person as coming from the person', () => {
    messages.sendFromHuman({
      toId: 'ren-id',
      subject: 'Priorities',
      body: 'Review the login PR first.',
    })
    const text = router.turnEnded('ren-id', true) ?? ''
    expect(text).toContain('From: the person you work for')
    expect(text).toContain('to: "human"')
    expect(text).not.toContain('not the person you work for')
  })

  it('mentions the task it is about', () => {
    const mission = fx.missions.createMission({ title: 'M' })
    const task = fx.missions.createTask({ missionId: mission.id, title: 'T' })
    send('mika-id', 'ren-id', 's', 'b', { taskId: task.id })
    expect(router.turnEnded('ren-id', true)).toContain(`About task: ${task.id}`)
  })
})

describe('paste (for an agent that is already idle)', () => {
  it('pastes to an agent that may safely receive it, and records that', async () => {
    const m = send('mika-id', 'ren-id', 'Ping', 'hello')
    delivery.ready.add('ren-id')
    await router.tick()
    expect(delivery.delivered).toHaveLength(1)
    expect(delivery.delivered[0]?.employeeId).toBe('ren-id')
    expect(delivery.delivered[0]?.text).toContain('hello')
    expect(messages.getMessage(m.id)?.state).toBe('delivered')
    expect(fx.eventsOf('message.delivered')[0]?.payload).toMatchObject({ via: 'paste' })
  })

  it('waits for an agent that cannot safely receive input, keeping the message queued', async () => {
    const m = send('mika-id', 'ren-id', 's', 'b')
    await router.tick()
    expect(delivery.delivered).toEqual([])
    expect(messages.getMessage(m.id)?.state).toBe('queued')
  })

  it('serves every agent that has something waiting', async () => {
    send('mika-id', 'ren-id', 'to ren', 'b')
    send('ren-id', 'mika-id', 'to mika', 'b')
    delivery.ready.add('ren-id').add('mika-id')
    await router.tick()
    expect(delivery.delivered.map((d) => d.employeeId).sort()).toEqual(['mika-id', 'ren-id'])
  })

  it('does not deliver the same message twice when passes overlap', async () => {
    send('mika-id', 'ren-id', 's', 'b')
    delivery.ready.add('ren-id')
    await Promise.all([router.tick(), router.tick(), router.tick()])
    expect(delivery.delivered).toHaveLength(1)
  })

  it('keeps the message and backs off when delivery fails', async () => {
    const m = send('mika-id', 'ren-id', 's', 'b')
    delivery.ready.add('ren-id')
    delivery.failWith = 'terminal went away'
    await router.tick()
    expect(messages.getMessage(m.id)?.state).toBe('queued')
    delivery.failWith = null
    await router.tick() // inside the cooldown
    expect(delivery.delivered).toEqual([])
    clock += 10_000
    await router.tick()
    expect(delivery.delivered).toHaveLength(1)
  })

  it('reacts to new messages by itself once started', async () => {
    delivery.ready.add('ren-id')
    router.start()
    send('mika-id', 'ren-id', 's', 'b')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(delivery.delivered).toHaveLength(1)
  })

  it('does not act once stopped', async () => {
    delivery.ready.add('ren-id')
    router.start()
    router.stop()
    send('mika-id', 'ren-id', 's', 'b')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(delivery.delivered).toEqual([])
  })
})

describe('while the circuit breaker limits an agent', () => {
  let limited: Set<string>
  let gated: MessageRouter

  beforeEach(() => {
    limited = new Set()
    gated = new MessageRouter({
      messages,
      delivery,
      directory: { list: () => fx.directory() },
      events: fx.services.events,
      logger: createLogger(() => {}),
      now: () => clock,
      // Constrained: only the person gets through.
      allowsDelivery: (id, fromPerson) => !limited.has(id) || fromPerson,
    })
  })
  afterEach(() => gated.stop())

  it("keeps a teammate's message back, but lets the person's through, at the end of a turn", () => {
    limited.add('ren-id')
    const fromMika = send('mika-id', 'ren-id', 'Q', 'from a teammate')
    messages.sendFromHuman({ toId: 'ren-id', subject: 'Steer', body: 'from the person' })

    const text = gated.turnEnded('ren-id', true)
    expect(text).toContain('from the person')
    expect(text).not.toContain('from a teammate')
    expect(messages.getMessage(fromMika.id)?.state).toBe('queued')
  })

  it("does not paste a teammate's message into it, and does once the restriction is lifted", async () => {
    limited.add('ren-id')
    const m = send('mika-id', 'ren-id', 'Q', 'from a teammate')
    delivery.ready.add('ren-id')

    await gated.tick()
    expect(delivery.delivered).toEqual([])
    expect(messages.getMessage(m.id)?.state).toBe('queued')

    limited.delete('ren-id')
    await gated.tick()
    expect(delivery.delivered).toHaveLength(1)
    expect(messages.getMessage(m.id)?.state).toBe('delivered')
  })

  it("leaves every message queued for a paused agent, including the person's", async () => {
    const paused = new MessageRouter({
      messages,
      delivery,
      directory: { list: () => fx.directory() },
      events: fx.services.events,
      logger: createLogger(() => {}),
      now: () => clock,
      allowsDelivery: () => false,
    })
    messages.sendFromHuman({ toId: 'ren-id', subject: 's', body: 'b' })
    delivery.ready.add('ren-id')
    await paused.tick()
    expect(paused.turnEnded('ren-id', true)).toBeNull()
    expect(delivery.delivered).toEqual([])
    paused.stop()
  })
})
