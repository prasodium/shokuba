import { describe, expect, it } from 'vitest'
import { initialView } from '@shared/agents/view'
import type { EventInput, ShokubaEvent } from '@shared/events/schema'
import { foldEvent, foldEvents, type AgentsState } from './fold'

let seq = 100
const ev = (input: EventInput, at = ++seq): ShokubaEvent => ({
  ...input,
  seq: at,
  id: `id-${at}`,
  ts: `t${at}`,
})
const empty: AgentsState = { views: {}, lastSeq: 0 }
const withA: AgentsState = { views: { a: initialView('a', 't0') }, lastSeq: 100 }

const change = (id: string, to: 'coding' | 'idle') =>
  ev({
    type: 'agent.state.changed',
    source: 'reported',
    payload: { employeeId: id, from: 'idle', to },
  })

describe('foldEvent', () => {
  it('adds a view when an employee is created', () => {
    const next = foldEvent(
      empty,
      ev({
        type: 'agent.created',
        source: 'user',
        payload: { employeeId: 'a', providerId: 'mock' },
      }),
    )
    expect(next.views['a']).toMatchObject({ state: 'offline' })
  })

  it('updates only the affected view, keeping the others by reference', () => {
    const state: AgentsState = {
      views: { a: initialView('a', 't'), b: initialView('b', 't') },
      lastSeq: 100,
    }
    const next = foldEvent(state, change('a', 'coding'))
    expect(next.views['a']?.state).toBe('coding')
    expect(next.views['b']).toBe(state.views['b'])
  })

  it('ignores events it has already seen', () => {
    const event = change('a', 'coding')
    const once = foldEvent(withA, event)
    expect(foldEvent(once, event)).toBe(once)
    expect(foldEvent(once, { ...event, seq: 1 })).toBe(once)
  })

  it('keeps the same views object when nothing about any agent changed', () => {
    const next = foldEvent(withA, ev({ type: 'app.stopping', source: 'system', payload: {} }))
    expect(next.views).toBe(withA.views)
    expect(next.lastSeq).toBeGreaterThan(withA.lastSeq)
  })

  it('drops the view of an archived employee', () => {
    const next = foldEvent(
      withA,
      ev({
        type: 'employee.updated',
        source: 'user',
        payload: { employeeId: 'a', fields: ['archived'] },
      }),
    )
    expect(next.views['a']).toBeUndefined()
  })

  it('does not drop a view for an ordinary edit', () => {
    const next = foldEvent(
      withA,
      ev({
        type: 'employee.updated',
        source: 'user',
        payload: { employeeId: 'a', fields: ['name'] },
      }),
    )
    expect(next.views['a']).toBeDefined()
  })
})

describe('foldEvents', () => {
  it('applies events in seq order regardless of arrival order', () => {
    const early = change('a', 'coding')
    const late = ev({
      type: 'agent.state.changed',
      source: 'reported',
      payload: { employeeId: 'a', from: 'coding', to: 'idle' },
    })
    expect(foldEvents(withA, [late, early]).views['a']?.state).toBe('idle')
  })
})
