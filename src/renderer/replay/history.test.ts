import { describe, expect, it } from 'vitest'
import { initialView } from '@shared/agents/view'
import { EventInputSchema, type EventInput, type ShokubaEvent } from '@shared/events/schema'
import { foldEvent } from '../store/fold'
import {
  EMPTY_REPLAY,
  ReplayHistory,
  foldReplay,
  matchingEvents,
  type ReplayState,
} from './history'
import { generateStream, seeded } from './stream'

let seq = 0
const ev = (input: EventInput, ts = '2026-01-01T00:00:00.000Z'): ShokubaEvent =>
  ({ ...input, seq: ++seq, id: `id-${seq}`, ts }) as ShokubaEvent
const created = (employeeId: string) =>
  ev({ type: 'agent.created', source: 'user', payload: { employeeId, providerId: 'mock' } })
const coding = (employeeId: string) =>
  ev({
    type: 'agent.state.changed',
    source: 'reported',
    payload: { employeeId, from: 'idle', to: 'coding' },
  })

/** The live window's way: one event at a time, as each arrives. */
function liveStates(events: readonly ShokubaEvent[]): ReplayState[] {
  const states: ReplayState[] = [EMPTY_REPLAY]
  let state = EMPTY_REPLAY
  for (const event of events) {
    state = foldReplay(state, event)
    states.push(state)
  }
  return states
}

describe('the generated streams', () => {
  it('are valid events, the same for the same seed', () => {
    const events = generateStream({ seed: 7, length: 2_000 })
    for (const event of events) {
      const input = { type: event.type, source: event.source, payload: event.payload }
      expect(EventInputSchema.safeParse(input).success).toBe(true)
    }
    expect(generateStream({ seed: 7, length: 50 })).toEqual(generateStream({ seed: 7, length: 50 }))
  })
})

describe('folding for replay', () => {
  it('is the live reducer when the app does not restart', () => {
    const events = [created('a'), created('b'), coding('a')]
    let live = { views: {}, lastSeq: 0 }
    for (const event of events) live = foldEvent(live, event)
    expect(events.reduce(foldReplay, EMPTY_REPLAY).agents).toEqual(live)
  })

  it('gives everyone a fresh view when the app starts again, as the main process does', () => {
    const before = [created('a'), coding('a')]
    const start = ev(
      { type: 'app.started', source: 'system', payload: { version: '1', platform: 'linux' } },
      '2026-01-02T00:00:00.000Z',
    )
    const state = [...before, start].reduce(foldReplay, EMPTY_REPLAY)
    expect(state.agents.views['a']).toEqual(initialView('a', start.ts))
    expect(state.agents.lastSeq).toBe(start.seq)
  })

  it('does not reset for an app start it has already seen', () => {
    const start = ev({
      type: 'app.started',
      source: 'system',
      payload: { version: '1', platform: 'linux' },
    })
    const before = [created('a'), start, coding('a')].reduce(foldReplay, EMPTY_REPLAY)
    expect(foldReplay(before, start)).toBe(before)
  })

  it('remembers who each task was last handed to, from the events alone', () => {
    const dispatched = (taskId: string, employeeId: string) =>
      ev({
        type: 'task.dispatched',
        source: 'system',
        payload: { taskId, missionId: 'm', employeeId, attempt: 1 },
      })
    const assigned = (taskId: string, employeeId: string | null) =>
      ev({ type: 'task.assigned', source: 'user', payload: { taskId, missionId: 'm', employeeId } })
    let state = [dispatched('t1', 'a'), assigned('t2', 'b')].reduce(foldReplay, EMPTY_REPLAY)
    expect(state.assignees).toEqual({ t1: 'a', t2: 'b' })
    state = [assigned('t1', 'c'), assigned('t2', null)].reduce(foldReplay, state)
    expect(state.assignees).toEqual({ t1: 'c' })
    // Nothing new keeps the same record of who holds what.
    expect(foldReplay(state, assigned('t1', 'c')).assignees).toBe(state.assignees)
    expect(foldReplay(state, assigned('t9', null)).assignees).toBe(state.assignees)
  })
})

describe('replaying to any moment', () => {
  it('gives exactly the state the live window had there, over many generated streams and seeks', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const events = generateStream({ seed, length: 1_500 })
      const live = liveStates(events)
      for (const every of [Number.POSITIVE_INFINITY, 64]) {
        const history = new ReplayHistory(events, every)
        const random = seeded(seed * 31)
        for (let i = 0; i < 200; i += 1) {
          const target = Math.floor(random() * (events.length + 1))
          expect(history.stateAt(target), `seed ${seed}, to ${target}`).toEqual(live[target])
        }
        // And every moment, in order, then backwards.
        for (let n = 0; n <= events.length; n += 37) expect(history.stateAt(n)).toEqual(live[n])
        for (let n = events.length; n >= 0; n -= 41) expect(history.stateAt(n)).toEqual(live[n])
      }
    }
  })

  it('saves a checkpoint every so many events, once each, and none without them', () => {
    const events = generateStream({ seed: 1, length: 100 })
    const history = new ReplayHistory(events, 10)
    history.stateAt(100)
    expect(history.checkpointCount).toBe(11)
    history.stateAt(35)
    history.stateAt(100)
    expect(history.checkpointCount).toBe(11)
    const plain = new ReplayHistory(events)
    plain.stateAt(100)
    expect(plain.checkpointCount).toBe(1)
  })

  it('keeps every moment inside the log', () => {
    const events = [created('a'), coding('a')]
    const history = new ReplayHistory(events)
    expect(history.length).toBe(2)
    expect(history.stateAt(-5)).toBe(EMPTY_REPLAY)
    expect(history.stateAt(99).agents.views['a']?.state).toBe('coding')
    expect(history.stateAt(0.4)).toBe(EMPTY_REPLAY)
  })

  it('seeks a 100,000-event log in well under a second', () => {
    const events = generateStream({ seed: 42, length: 100_000 })
    const history = new ReplayHistory(events)
    const time = (fn: () => void): number => {
      const start = performance.now()
      fn()
      return performance.now() - start
    }
    const toEnd = time(() => history.stateAt(events.length))
    const back = time(() => history.stateAt(events.length - 1))
    console.info(
      `replay seek on 100k events: to the end ${toEnd.toFixed(0)} ms, one back ${back.toFixed(0)} ms`,
    )
    // Generous for slow CI machines; the measured numbers are in docs/ARCHITECTURE.md.
    expect(toEnd).toBeLessThan(1_000)
    expect(back).toBeLessThan(1_000)
  })
})

describe('narrowing replay to a mission or an employee', () => {
  const events = [
    created('a'),
    ev({
      type: 'task.dispatched',
      source: 'system',
      payload: { taskId: 't1', missionId: 'm1', employeeId: 'a', attempt: 1 },
    }),
    coding('b'),
    ev({
      type: 'task.status.changed',
      source: 'system',
      payload: { taskId: 't1', from: 'running', to: 'submitted' },
    } as unknown as EventInput),
    ev({
      type: 'message.sent',
      source: 'reported',
      payload: { messageId: 'x', conversationId: 'c', fromId: 'b', toId: 'a', kind: 'question' },
    } as unknown as EventInput),
  ]

  it('finds nothing without a filter', () => {
    expect(matchingEvents(events, null)).toEqual([])
  })

  it('finds a mission’s events, including those that name only its task', () => {
    expect(matchingEvents(events, { kind: 'mission', id: 'm1' })).toEqual([1, 3])
    expect(matchingEvents(events, { kind: 'mission', id: 'm2' })).toEqual([])
  })

  it('finds an employee’s events, whichever side of a message they are on', () => {
    expect(matchingEvents(events, { kind: 'employee', id: 'a' })).toEqual([0, 1, 4])
    expect(matchingEvents(events, { kind: 'employee', id: 'b' })).toEqual([2, 4])
  })
})
