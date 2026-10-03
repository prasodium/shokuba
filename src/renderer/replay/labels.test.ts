import { describe, expect, it } from 'vitest'
import { initialView } from '@shared/agents/view'
import type { EventInput, ShokubaEvent } from '@shared/events/schema'
import { eventsUpTo, positionLabel, presentAt, removedSince, subjectAt } from './labels'

let seq = 0
const ev = (input: EventInput): ShokubaEvent =>
  ({
    ...input,
    seq: ++seq,
    id: `i${seq}`,
    ts: `2026-01-01T00:00:0${seq % 10}.000Z`,
  }) as ShokubaEvent
const named = (conversationId: string, subject: string) =>
  ev({ type: 'conversation.created', source: 'user', payload: { conversationId, subject } })
const other = () => ev({ type: 'app.stopping', source: 'system', payload: {} })

const views = { a: initialView('a', 't'), gone: initialView('gone', 't') }

describe('who replay can draw', () => {
  it('only people hired by then and still here', () => {
    expect(presentAt([{ id: 'a' }, { id: 'later' }], views)).toEqual([{ id: 'a' }])
  })

  it('counts those there then but removed since', () => {
    expect(removedSince([{ id: 'a' }, { id: 'later' }], views)).toBe(1)
    expect(removedSince([{ id: 'a' }, { id: 'gone' }], views)).toBe(0)
  })
})

describe('where the cursor is', () => {
  const events = [other(), other(), other()]
  const time = (iso: string) => `[${iso.slice(11, 19)}]`

  it('names the last event that has happened and how far through the log it is', () => {
    expect(positionLabel(events, 2, time)).toBe(
      `#${events[1]!.seq} · [${events[1]!.ts.slice(11, 19)}] · 2 of 3`,
    )
    expect(positionLabel(events, 99, time)).toMatch(/· 3 of 3$/)
  })

  it('before the first event, and an empty log', () => {
    expect(positionLabel(events, 0, time)).toBe('Before the first event · 0 of 3')
    expect(positionLabel([], 0, time)).toBe('The log is empty')
  })
})

describe('the log at the cursor', () => {
  const events = [other(), other(), other(), other()]

  it('is the newest events that have happened, newest first', () => {
    expect(eventsUpTo(events, 3, 2).map((e) => e.seq)).toEqual([events[2]!.seq, events[1]!.seq])
    expect(eventsUpTo(events, 0)).toEqual([])
    expect(eventsUpTo(events, 99, 10)).toHaveLength(4)
    expect(eventsUpTo(events, -4)).toEqual([])
  })
})

describe('a conversation’s subject at the cursor', () => {
  it('is what it was called by then, and nothing from later', () => {
    const events = [named('c1', 'First'), other(), named('c2', 'Second')]
    expect(subjectAt(events, 3, 'c1')).toBe('First')
    expect(subjectAt(events, 2, 'c2')).toBeNull()
    expect(subjectAt(events, 3, 'c2')).toBe('Second')
    expect(subjectAt(events, 99, 'c3')).toBeNull()
  })
})
