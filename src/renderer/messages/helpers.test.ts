import { describe, expect, it } from 'vitest'
import { HUMAN, type ConversationDetail, type Message } from '@shared/messages'
import {
  attentionCount,
  defaultRecipient,
  hasUnread,
  haltedCount,
  nameOf,
  stateLabel,
  unreadCount,
} from './helpers'

const message = (patch: Partial<Message>): Message => ({
  id: 'm',
  conversationId: 'c',
  parentId: null,
  hop: 1,
  fromId: 'mika',
  toId: 'ren',
  kind: 'inform',
  subject: 's',
  body: 'b',
  taskId: null,
  state: 'delivered',
  heldReason: null,
  createdAt: 't',
  deliveredAt: 't',
  readAt: null,
  ...patch,
})

const conversation = (
  status: 'open' | 'halted' | 'closed',
  messages: Message[],
): ConversationDetail => ({
  conversation: {
    id: 'c',
    subject: 's',
    status,
    haltedReason: null,
    missionId: null,
    hopBase: 0,
    createdAt: 't',
    updatedAt: 't',
  },
  messages,
})

describe('nameOf', () => {
  it('calls the person "You", employees by name, and a missing one what it is', () => {
    expect(nameOf(HUMAN, {})).toBe('You')
    expect(nameOf('mika', { mika: 'Mika' })).toBe('Mika')
    expect(nameOf('gone', {})).toBe('Removed employee')
  })
})

describe('what needs attention', () => {
  const unread = message({ toId: HUMAN })
  const read = message({ toId: HUMAN, readAt: 'now' })

  it('counts unread messages to the person only', () => {
    expect(unreadCount([conversation('open', [unread, read, message({ toId: 'ren' })])])).toBe(1)
  })

  it('counts halted conversations', () => {
    expect(
      haltedCount([
        conversation('halted', []),
        conversation('open', []),
        conversation('closed', []),
      ]),
    ).toBe(1)
  })

  it('adds the two together', () => {
    expect(attentionCount([conversation('halted', [unread])])).toBe(2)
    expect(attentionCount([])).toBe(0)
  })

  it('says which conversation has something new', () => {
    expect(hasUnread(conversation('open', [unread]))).toBe(true)
    expect(hasUnread(conversation('open', [read]))).toBe(false)
  })
})

describe('defaultRecipient', () => {
  const ids = ['mika', 'ren']

  it('replies to whoever last wrote to the person', () => {
    const detail = conversation('open', [
      message({ fromId: 'mika', toId: HUMAN }),
      message({ fromId: 'ren', toId: HUMAN }),
    ])
    expect(defaultRecipient(detail, ids)).toBe('ren')
  })

  it("goes to the person's last addressee when they spoke last", () => {
    const detail = conversation('open', [message({ fromId: HUMAN, toId: 'mika' })])
    expect(defaultRecipient(detail, ids)).toBe('mika')
  })

  it('skips employees who no longer exist', () => {
    const detail = conversation('open', [
      message({ fromId: 'mika', toId: HUMAN }),
      message({ fromId: 'gone', toId: HUMAN }),
    ])
    expect(defaultRecipient(detail, ids)).toBe('mika')
    expect(defaultRecipient(conversation('open', []), ids)).toBeNull()
  })
})

describe('stateLabel', () => {
  it('describes each state, including why a message was held', () => {
    expect(stateLabel({ state: 'queued', heldReason: null, toId: 'ren' })).toBe(
      'Waiting to be delivered',
    )
    expect(stateLabel({ state: 'delivered', heldReason: null, toId: 'ren' })).toBe('Delivered')
    expect(stateLabel({ state: 'delivered', heldReason: null, toId: HUMAN })).toBe('In your inbox')
    expect(
      stateLabel({ state: 'held', heldReason: 'the chain of replies passed 6 hops', toId: 'ren' }),
    ).toBe('Held: the chain of replies passed 6 hops')
  })
})
