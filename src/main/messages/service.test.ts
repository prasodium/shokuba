import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HUMAN, MAX_HOPS, MAX_QUEUED_PER_RECIPIENT } from '@shared/messages'
import { createMissionFixture, type MissionFixture } from '../missions/fixtures'
import { MessageError, MessageService } from './service'

let fx: MissionFixture
let messages: MessageService

beforeEach(() => {
  fx = createMissionFixture()
  fx.addEmployee('mika-id', 'Mika', 'Engineer')
  fx.addEmployee('ren-id', 'Ren', 'Reviewer')
  messages = new MessageService({
    db: fx.services.db,
    events: fx.services.events,
    directory: { list: () => fx.directory() },
    taskMissionId: (id) => fx.missions.getTask(id)?.missionId,
    now: (() => {
      let t = 0
      return () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++t))
    })(),
  })
})

afterEach(() => fx.cleanup())

const AGENT = { source: 'reported' as const }
const send = (from: string, to: string, subject = 's', body = 'b', extra: object = {}) =>
  messages.sendFromAgent(from, { to, subject, body, ...extra }, { ...AGENT, employeeId: from })

/** Deliver the queued messages to `to`, so that whatever they send next is a reply. */
function deliver(to: string): void {
  messages.markDelivered(messages.queuedFor(to), 'paste')
}

async function rejection(work: () => unknown): Promise<MessageError> {
  try {
    work()
  } catch (error) {
    expect(error).toBeInstanceOf(MessageError)
    return error as MessageError
  }
  throw new Error('expected a MessageError')
}

describe('sending from an agent', () => {
  it('starts a conversation and queues the message for the recipient', () => {
    const m = send('mika-id', 'ren-id', 'API contract', 'Is /login POST?', { kind: 'question' })
    expect(m).toMatchObject({
      fromId: 'mika-id',
      toId: 'ren-id',
      kind: 'question',
      hop: 1,
      state: 'queued',
      parentId: null,
    })
    const conversation = messages.getConversation(m.conversationId)
    expect(conversation).toMatchObject({ subject: 'API contract', status: 'open', hopBase: 0 })
    expect(fx.eventsOf('conversation.created')).toHaveLength(1)
    expect(fx.eventsOf('message.sent')[0]).toMatchObject({
      source: 'reported',
      actorId: 'mika-id',
      payload: { messageId: m.id, fromId: 'mika-id', toId: 'ren-id', hop: 1 },
    })
  })

  it('finds the recipient by id, by name in any case, or as "human"', () => {
    expect(send('mika-id', 'ren-id').toId).toBe('ren-id')
    expect(send('mika-id', 'REN').toId).toBe('ren-id')
    expect(send('mika-id', ' ren ').toId).toBe('ren-id')
    const toPerson = send('mika-id', 'human')
    expect(toPerson.toId).toBe(HUMAN)
  })

  it('a message to the person is delivered at once and waits unread', () => {
    const m = send('mika-id', 'human', 'Need a decision', 'Use SQLite or Postgres?')
    expect(m).toMatchObject({ state: 'delivered', readAt: null })
    expect(m.deliveredAt).not.toBeNull()
  })

  it('refuses unknown recipients, ambiguous names and messaging yourself', async () => {
    expect((await rejection(() => send('mika-id', 'nobody'))).code).toBe('unknown-recipient')
    expect((await rejection(() => send('mika-id', 'mika-id'))).code).toBe('self')
    expect((await rejection(() => send('mika-id', 'Mika'))).code).toBe('self')
    fx.addEmployee('ren2-id', 'ren', 'QA')
    expect((await rejection(() => send('mika-id', 'Ren'))).code).toBe('ambiguous')
    expect(send('mika-id', 'ren2-id').toId).toBe('ren2-id') // an id is never ambiguous
  })

  it('validates content', async () => {
    expect((await rejection(() => send('mika-id', 'ren-id', '', 'b'))).code).toBe('invalid')
    expect((await rejection(() => send('mika-id', 'ren-id', 'two\nlines', 'b'))).code).toBe(
      'invalid',
    )
    expect((await rejection(() => send('mika-id', 'ren-id', 's', ''))).code).toBe('invalid')
    expect((await rejection(() => send('mika-id', 'ren-id', 's', 'x'.repeat(4001)))).code).toBe(
      'invalid',
    )
    expect(
      (await rejection(() => send('mika-id', 'ren-id', 's', `a${String.fromCharCode(27)}b`))).code,
    ).toBe('invalid')
  })

  it('links a task to its mission, and rejects one that does not exist', async () => {
    const mission = fx.missions.createMission({ title: 'M' })
    const task = fx.missions.createTask({ missionId: mission.id, title: 'T' })
    const m = send('mika-id', 'ren-id', 's', 'b', { taskId: task.id })
    expect(m.taskId).toBe(task.id)
    expect(messages.getConversation(m.conversationId)?.missionId).toBe(mission.id)
    expect(
      (await rejection(() => send('mika-id', 'ren-id', 's', 'b', { taskId: 'ghost' }))).code,
    ).toBe('invalid')
  })

  it('redacts secrets in what it stores, and puts no body in any event', () => {
    const secret = ['sk', 'ant', 'api03'].join('-') + '-' + 'A'.repeat(40)
    const m = send('mika-id', 'ren-id', `key ${secret}`, `use ${secret} to log in`)
    expect(m.body).not.toContain(secret)
    expect(m.subject).not.toContain(secret)
    const log = JSON.stringify(fx.eventsOf())
    expect(log).not.toContain(secret)
    expect(log).not.toContain('to log in')
  })

  it('a failed send changes and announces nothing', async () => {
    const before = fx.eventsOf().length
    await rejection(() => send('mika-id', 'nobody'))
    expect(fx.eventsOf()).toHaveLength(before)
    expect(messages.listConversations()).toEqual([])
  })

  it('stops a sender flooding one recipient', async () => {
    for (let i = 0; i < MAX_QUEUED_PER_RECIPIENT; i++) send('mika-id', 'ren-id', `s${i}`)
    expect((await rejection(() => send('mika-id', 'ren-id'))).code).toBe('full')
    // ...but they can still reach the person, and someone else.
    expect(send('mika-id', 'human').state).toBe('delivered')
  })
})

describe('replies and hops', () => {
  it('counts a message sent while handling another as a reply, one hop deeper, in the same conversation', () => {
    const first = send('mika-id', 'ren-id', 'Q', 'question')
    deliver('ren-id') // Ren is now answering it
    const reply = send('ren-id', 'mika-id', 'Re: Q', 'answer')
    expect(reply).toMatchObject({
      conversationId: first.conversationId,
      parentId: first.id,
      hop: 2,
    })
    deliver('mika-id')
    const again = send('mika-id', 'ren-id', 'Re: Re: Q', 'thanks')
    expect(again).toMatchObject({ parentId: reply.id, hop: 3 })
  })

  it('does not depend on the sender saying what it is replying to', () => {
    send('mika-id', 'ren-id')
    deliver('ren-id')
    // The tool has no "reply to" field at all: the parent is worked out.
    const reply = messages.sendFromAgent(
      'ren-id',
      { to: 'mika-id', subject: 'x', body: 'y' },
      AGENT,
    )
    expect(reply.parentId).not.toBeNull()
    expect(reply.hop).toBe(2)
  })

  it('starts a new conversation once the agent finishes handling the message', () => {
    const first = send('mika-id', 'ren-id')
    deliver('ren-id')
    messages.endHandling('ren-id')
    const fresh = send('ren-id', 'mika-id', 'Unrelated', 'hello')
    expect(fresh.conversationId).not.toBe(first.conversationId)
    expect(fresh).toMatchObject({ hop: 1, parentId: null })
  })

  it('only forgets the message it answers when the agent ends its turn', () => {
    send('mika-id', 'ren-id')
    deliver('ren-id')
    expect(messages.handlingFor('ren-id')).toBeDefined()
    messages.endHandling('ren-id')
    expect(messages.handlingFor('ren-id')).toBeUndefined()
  })
})

describe('loop protection', () => {
  /** Two agents that keep answering each other, until something stops them. */
  function pingPong(rounds: number) {
    const sent = [send('mika-id', 'ren-id', 'ping', 'ping')]
    for (let i = 0; i < rounds; i++) {
      const from = i % 2 === 0 ? 'ren-id' : 'mika-id'
      const to = i % 2 === 0 ? 'mika-id' : 'ren-id'
      deliver(from)
      try {
        sent.push(send(from, to, 'pong', 'pong'))
      } catch {
        break
      }
    }
    return sent
  }

  it('lets a chain run up to the hop limit', () => {
    const sent = pingPong(MAX_HOPS - 1)
    expect(sent).toHaveLength(MAX_HOPS)
    expect(sent.every((m) => m.state !== 'held')).toBe(true)
    expect(messages.getConversation(sent[0]!.conversationId)?.status).toBe('open')
  })

  it('holds the message that passes the limit and halts the conversation', () => {
    const sent = pingPong(MAX_HOPS)
    const last = sent.at(-1)!
    expect(sent).toHaveLength(MAX_HOPS + 1)
    expect(last).toMatchObject({ hop: MAX_HOPS + 1, state: 'held' })
    expect(last.heldReason).toContain(`${MAX_HOPS} hops`)
    const conversation = messages.getConversation(last.conversationId)
    expect(conversation?.status).toBe('halted')
    expect(conversation?.haltedReason).toContain('possible loop')
    expect(fx.eventsOf('message.held')).toHaveLength(1)
    const change = fx.eventsOf('conversation.status.changed').at(-1)
    expect(change).toMatchObject({ source: 'system', payload: { from: 'open', to: 'halted' } })
  })

  it('does not deliver a held message', () => {
    const sent = pingPong(MAX_HOPS)
    const held = sent.at(-1)!
    expect(messages.queuedFor(held.toId).map((m) => m.id)).not.toContain(held.id)
  })

  it('holds everything further sent in a halted conversation', () => {
    const sent = pingPong(MAX_HOPS)
    const from = sent.at(-1)!.toId
    deliver(from)
    // (the agent that was last handed something tries to carry on)
    messages.markDelivered([sent.at(-2)!], 'paste')
    const more = send(sent.at(-2)!.toId, sent.at(-2)!.fromId, 'more', 'more')
    expect(more.state).toBe('held')
    expect(more.heldReason).toBe('this conversation is halted')
  })

  it('a person resuming it lets the chain count again from there, and releases what was held', () => {
    const sent = pingPong(MAX_HOPS)
    const held = sent.at(-1)!
    const resumed = messages.resume(held.conversationId)
    expect(resumed.status).toBe('open')
    expect(resumed.hopBase).toBe(MAX_HOPS + 1)
    expect(messages.getMessage(held.id)?.state).toBe('queued')
    // The released message goes to its recipient, who can now reply as normal.
    deliver(held.toId)
    const reply = send(held.toId, held.fromId, 'ok', 'ok')
    expect(reply.state).toBe('queued')
    expect(reply.hop).toBe(MAX_HOPS + 2)
  })

  it('a message from the person resets the chain, even without pressing Resume', () => {
    const sent = pingPong(MAX_HOPS)
    const conversationId = sent[0]!.conversationId
    const human = messages.sendFromHuman({
      toId: 'mika-id',
      subject: 'Stop',
      body: 'Please stop and wait.',
      conversationId,
    })
    expect(messages.getConversation(conversationId)?.status).toBe('open')
    expect(human.hop).toBe(MAX_HOPS + 2)
    expect(messages.getConversation(conversationId)?.hopBase).toBe(human.hop)
    deliver('mika-id')
    const reply = send('mika-id', 'ren-id', 'ack', 'stopped')
    expect(reply.state).toBe('queued')
  })

  it('cannot be dodged by an agent that starts a "new" conversation while answering', () => {
    // Whatever it tries to send while handling a message is a reply, in the same conversation.
    const first = send('mika-id', 'ren-id')
    deliver('ren-id')
    const dodge = send('ren-id', 'mika-id', 'Brand new topic', 'unrelated')
    expect(dodge.conversationId).toBe(first.conversationId)
    expect(dodge.hop).toBe(2)
  })

  it('can only resume a conversation that is halted', async () => {
    const m = send('mika-id', 'ren-id')
    expect((await rejection(() => messages.resume(m.conversationId))).code).toBe('state')
  })
})

describe('closing', () => {
  it('holds what was waiting, and refuses further sends in it', async () => {
    const first = send('mika-id', 'ren-id')
    deliver('ren-id')
    const reply = send('ren-id', 'mika-id')
    messages.close(first.conversationId)
    expect(messages.getMessage(reply.id)).toMatchObject({
      state: 'held',
      heldReason: 'the conversation was closed',
    })
    expect(messages.getConversation(first.conversationId)?.status).toBe('closed')
    // Ren is still handling it; a further reply is refused, with a message meant for the model.
    const error = await rejection(() => send('ren-id', 'mika-id'))
    expect(error.code).toBe('closed')
    expect(error.message).toContain('closed')
  })

  it('cannot be closed twice, or written into by the person', async () => {
    const m = send('mika-id', 'ren-id')
    messages.close(m.conversationId)
    expect((await rejection(() => messages.close(m.conversationId))).code).toBe('state')
    const write = () =>
      messages.sendFromHuman({
        toId: 'ren-id',
        subject: 's',
        body: 'b',
        conversationId: m.conversationId,
      })
    expect((await rejection(write)).code).toBe('closed')
  })
})

describe('from the person', () => {
  it('starts a conversation with an employee', () => {
    const m = messages.sendFromHuman({
      toId: 'ren-id',
      subject: 'Priorities',
      body: 'Review the login PR first.',
    })
    expect(m).toMatchObject({
      fromId: HUMAN,
      toId: 'ren-id',
      hop: 1,
      state: 'queued',
      kind: 'inform',
    })
    expect(fx.eventsOf('message.sent').at(-1)).toMatchObject({ source: 'user' })
  })

  it('only goes to an employee who exists', async () => {
    expect(
      (await rejection(() => messages.sendFromHuman({ toId: 'ghost', subject: 's', body: 'b' })))
        .code,
    ).toBe('unknown-recipient')
    expect(
      (await rejection(() => messages.sendFromHuman({ toId: HUMAN, subject: 's', body: 'b' })))
        .code,
    ).toBe('unknown-recipient')
  })

  it('continues an existing conversation', () => {
    const first = send('mika-id', 'human', 'Question', 'A or B?')
    const answer = messages.sendFromHuman({
      toId: 'mika-id',
      subject: 'Re: Question',
      body: 'B.',
      conversationId: first.conversationId,
    })
    expect(answer).toMatchObject({ conversationId: first.conversationId, parentId: first.id })
  })

  it('reading a conversation marks what was sent to the person in it as read, once', () => {
    const a = send('mika-id', 'human', 'one', '1')
    const b = send('ren-id', 'human', 'two', '2')
    messages.markRead(a.conversationId)
    expect(messages.getMessage(a.id)?.readAt).not.toBeNull()
    // A different conversation stays unread until it is opened.
    expect(messages.getMessage(b.id)?.readAt).toBeNull()
    const reads = fx.eventsOf('message.read').length
    messages.markRead(a.conversationId)
    expect(fx.eventsOf('message.read')).toHaveLength(reads)
  })
})

describe('delivery bookkeeping', () => {
  it('lists who has something waiting, oldest first', () => {
    const one = send('mika-id', 'ren-id', 'one')
    const two = send('mika-id', 'ren-id', 'two')
    send('ren-id', 'mika-id', 'three')
    expect(messages.recipientsWithQueued().sort()).toEqual(['mika-id', 'ren-id'])
    expect(messages.queuedFor('ren-id').map((m) => m.id)).toEqual([one.id, two.id])
    expect(messages.queuedFor('ren-id', 1)).toHaveLength(1)
  })

  it('records how a message was delivered, and delivers each only once', () => {
    const m = send('mika-id', 'ren-id')
    messages.markDelivered([m], 'continuation')
    expect(messages.getMessage(m.id)?.state).toBe('delivered')
    expect(fx.eventsOf('message.delivered')[0]?.payload).toMatchObject({
      messageId: m.id,
      via: 'continuation',
    })
    expect(messages.queuedFor('ren-id')).toEqual([])
  })
})

describe('listing', () => {
  it('shows recent conversations first, each with its messages in order', () => {
    const older = send('mika-id', 'ren-id', 'older')
    const newer = send('ren-id', 'mika-id', 'newer')
    const list = messages.listConversations()
    expect(list.map((c) => c.conversation.id)).toEqual([newer.conversationId, older.conversationId])
    expect(list[0]?.messages.map((m) => m.id)).toEqual([newer.id])
  })
})

describe('reporting lines', () => {
  beforeEach(() => {
    fx.addEmployee('mira-id', 'Mira', 'Manager', { isManager: true })
    fx.addEmployee('sora-id', 'Sora', 'QA', { reportsTo: 'mira-id' })
  })

  it('does not let an employee who reports to a manager message the person', async () => {
    const error = await rejection(() =>
      send('sora-id', HUMAN, 'Need a decision', 'SQLite or Postgres?'),
    )
    expect(error.code).toBe('via-manager')
    expect(error.message).toContain('You report to Mira')
    expect(error.message).toContain('send_message with to: "Mira"')
    // Nothing was created: not a message, not a conversation, not an event.
    expect(messages.listConversations()).toEqual([])
    expect(fx.eventsOf('message.sent')).toEqual([])
  })

  it('lets that employee ask their manager, who can then reach the person', () => {
    const up = send('sora-id', 'Mira', 'Question for the person', 'SQLite or Postgres?', {
      kind: 'question',
    })
    expect(up).toMatchObject({ fromId: 'sora-id', toId: 'mira-id', state: 'queued' })
    const onward = send('mira-id', HUMAN, 'Database choice', 'The team asks: SQLite or Postgres?')
    expect(onward).toMatchObject({ fromId: 'mira-id', toId: HUMAN, state: 'delivered' })
  })

  it('lets an employee still message their teammates', () => {
    const m = send('sora-id', 'mika-id', 'Heads up', 'Tests are flaky')
    expect(m).toMatchObject({ toId: 'mika-id', state: 'queued' })
  })

  it('leaves an employee with no manager free to message the person, as before', () => {
    expect(send('mika-id', HUMAN, 'Hello', 'Anyone there?')).toMatchObject({ toId: HUMAN })
  })

  it('lets a manager message the person', () => {
    expect(send('mira-id', HUMAN, 'Status', 'All good')).toMatchObject({ toId: HUMAN })
  })

  it('does not stop the person writing to anyone', () => {
    const m = messages.sendFromHuman({ toId: 'sora-id', subject: 'Steer', body: 'Focus on login' })
    expect(m).toMatchObject({ fromId: HUMAN, toId: 'sora-id' })
  })

  it('treats a reference to a manager who is gone as no manager at all', () => {
    // A reporting line to someone no longer in the directory must not lock the employee out.
    const ghost = new MessageService({
      db: fx.services.db,
      events: fx.services.events,
      directory: {
        list: () => [{ id: 'lone', name: 'Lone', role: 'Engineer', reportsTo: 'archived-manager' }],
      },
      taskMissionId: () => undefined,
    })
    expect(
      ghost.sendFromAgent('lone', { to: HUMAN, subject: 's', body: 'b' }, { source: 'reported' }),
    ).toMatchObject({ toId: HUMAN })
  })
})
