import { describe, expect, it } from 'vitest'
import type { ShokubaEvent } from '@shared/events/schema'
import {
  ARC_HEIGHT,
  FLIGHT_MS,
  FlightQueue,
  MAX_FLYING,
  MAX_WAITING,
  STALE_MS,
  ease,
  flightFor,
  flightPoint,
  type Flight,
  type HandoffContext,
} from './handoffs'

let seq = 0
const event = (type: string, payload: Record<string, unknown>): ShokubaEvent =>
  ({ seq: (seq += 1), id: `e${seq}`, ts: 't', source: 'system', type, payload }) as ShokubaEvent

const ctx: HandoffContext = { assigneeOf: (taskId) => (taskId === 'orphan' ? null : 'ava') }

const status = (to: string, taskId = 't1') =>
  event('task.status.changed', { taskId, missionId: 'm1', from: 'ready', to })

describe('flightFor', () => {
  it('hands a dispatched task from the board to the assignee’s desk', () => {
    const e = event('task.dispatched', {
      taskId: 't1',
      missionId: 'm1',
      employeeId: 'bo',
      attempt: 1,
    })
    expect(flightFor(e, ctx)).toEqual({
      key: String(e.seq),
      thing: 'card',
      from: { at: 'board' },
      to: { at: 'desk', id: 'bo' },
      tint: 'plain',
    })
  })

  it('carries submitted work from the assignee to your inbox', () => {
    expect(flightFor(status('submitted'), ctx)).toMatchObject({
      thing: 'card',
      from: { at: 'person', id: 'ava' },
      to: { at: 'inbox' },
      tint: 'plain',
    })
  })

  it('puts accepted work on the board, marked good', () => {
    expect(flightFor(status('done'), ctx)).toMatchObject({
      from: { at: 'inbox' },
      to: { at: 'board' },
      tint: 'good',
    })
  })

  it('sends work back to the assignee’s desk, marked bad', () => {
    expect(flightFor(status('changes_requested'), ctx)).toMatchObject({
      from: { at: 'inbox' },
      to: { at: 'desk', id: 'ava' },
      tint: 'bad',
    })
  })

  it('needs an assignee for work that goes to or from one, and flies nothing without', () => {
    expect(flightFor(status('submitted', 'orphan'), ctx)).toBeNull()
    expect(flightFor(status('changes_requested', 'orphan'), ctx)).toBeNull()
    // Accepting needs nobody: the card goes to the board either way.
    expect(flightFor(status('done', 'orphan'), ctx)).not.toBeNull()
  })

  it('ignores every other change of status', () => {
    for (const to of ['pending', 'ready', 'in_progress', 'blocked', 'cancelled']) {
      expect(flightFor(status(to), ctx)).toBeNull()
    }
  })

  it('carries a handed-in review from the reviewer to your inbox, marked with the verdict', () => {
    const handedIn = (verdict?: string) =>
      event('review.changed', {
        taskId: 't1',
        missionId: 'm1',
        reviewId: 'r1',
        reviewerId: 'cy',
        change: 'submitted',
        ...(verdict ? { verdict } : {}),
      })
    expect(flightFor(handedIn('approve'), ctx)).toMatchObject({
      from: { at: 'person', id: 'cy' },
      to: { at: 'inbox' },
      tint: 'good',
    })
    expect(flightFor(handedIn('request_changes'), ctx)?.tint).toBe('bad')
    expect(flightFor(handedIn('comment'), ctx)?.tint).toBe('warn')
    expect(flightFor(handedIn(), ctx)?.tint).toBe('plain')
  })

  it('flies nothing while a review is only asked for, begun, stopped or failed', () => {
    for (const change of ['requested', 'started', 'cancelled', 'error']) {
      const e = event('review.changed', {
        taskId: 't1',
        missionId: 'm1',
        reviewId: 'r1',
        reviewerId: 'cy',
        change,
      })
      expect(flightFor(e, ctx)).toBeNull()
    }
  })

  it('sends an envelope from one person to another’s desk', () => {
    const e = event('message.sent', {
      messageId: 'x',
      conversationId: 'c',
      fromId: 'ava',
      toId: 'bo',
      kind: 'inform',
      hop: 1,
    })
    expect(flightFor(e, ctx)).toMatchObject({
      thing: 'envelope',
      from: { at: 'person', id: 'ava' },
      to: { at: 'desk', id: 'bo' },
    })
  })

  it('uses your inbox for mail from you and to you', () => {
    const mail = (fromId: string, toId: string) =>
      flightFor(
        event('message.sent', {
          messageId: 'x',
          conversationId: 'c',
          fromId,
          toId,
          kind: 'request',
          hop: 1,
        }),
        ctx,
      )
    expect(mail('human', 'ava')).toMatchObject({
      from: { at: 'inbox' },
      to: { at: 'desk', id: 'ava' },
    })
    expect(mail('ava', 'human')).toMatchObject({
      from: { at: 'person', id: 'ava' },
      to: { at: 'inbox' },
    })
  })

  it('flies nothing for a note to oneself', () => {
    const e = event('message.sent', {
      messageId: 'x',
      conversationId: 'c',
      fromId: 'ava',
      toId: 'ava',
      kind: 'inform',
      hop: 1,
    })
    expect(flightFor(e, ctx)).toBeNull()
  })

  it('ignores events that are not about work moving', () => {
    expect(flightFor(event('agent.ready', { employeeId: 'ava' }), ctx)).toBeNull()
    expect(
      flightFor(event('task.created', { taskId: 't', missionId: 'm', title: 'x' }), ctx),
    ).toBeNull()
  })

  it('gives each event its own key', () => {
    const a = flightFor(status('done'), ctx)
    const b = flightFor(status('done'), ctx)
    expect(a?.key).not.toBe(b?.key)
  })
})

const flight = (key: string): Flight => ({
  key,
  thing: 'card',
  from: { at: 'board' },
  to: { at: 'inbox' },
  tint: 'plain',
})

describe('FlightQueue', () => {
  it('starts a flight at once and lands it after its time', () => {
    const q = new FlightQueue()
    q.push(flight('a'), 0)
    const first = q.update(0)
    expect(first.started.map((f) => f.key)).toEqual(['a'])
    expect(first.flying).toEqual([{ flight: flight('a'), progress: 0 }])

    expect(q.update(FLIGHT_MS / 2).flying[0]?.progress).toBeCloseTo(0.5)
    expect(q.update(FLIGHT_MS - 1).flying).toHaveLength(1)
    expect(q.update(FLIGHT_MS).flying).toEqual([])
  })

  it('reports a flight as started only once', () => {
    const q = new FlightQueue()
    q.push(flight('a'), 0)
    expect(q.update(0).started).toHaveLength(1)
    expect(q.update(100).started).toEqual([])
  })

  it('lets only so many fly at once, and the rest go as they land, in order', () => {
    const q = new FlightQueue()
    const keys = Array.from({ length: MAX_FLYING + 2 }, (_, i) => `f${i}`)
    for (const key of keys) q.push(flight(key), 0)
    const now = q.update(0)
    expect(now.flying).toHaveLength(MAX_FLYING)
    expect(now.started.map((f) => f.key)).toEqual(keys.slice(0, MAX_FLYING))

    const later = q.update(FLIGHT_MS)
    expect(later.started.map((f) => f.key)).toEqual(keys.slice(MAX_FLYING))
    expect(later.flying.map((f) => f.progress)).toEqual([0, 0])
  })

  it('keeps only the latest few waiting when a burst comes', () => {
    const q = new FlightQueue()
    for (let i = 0; i < MAX_FLYING; i += 1) q.push(flight(`up${i}`), 0)
    q.update(0)
    const burst = Array.from({ length: MAX_WAITING + 4 }, (_, i) => `b${i}`)
    for (const key of burst) q.push(flight(key), 10)
    // Every seat is still taken, so they wait, and the line holds only its latest few.
    expect(q.update(100).started).toEqual([])
    const started = q.update(FLIGHT_MS).started.map((f) => f.key)
    // The four oldest were pushed out; the latest six remain, in order.
    expect(started).toEqual(burst.slice(4))
  })

  it('cannot fill up while nothing is taking off', () => {
    const q = new FlightQueue()
    const keys = Array.from({ length: 30 }, (_, i) => `f${i}`)
    for (const key of keys) q.push(flight(key), 0)
    // Only the newest are kept, and they still go in the order they came.
    expect(q.update(0).started.map((f) => f.key)).toEqual(keys.slice(18, 24))
    expect(q.update(FLIGHT_MS).started.map((f) => f.key)).toEqual(keys.slice(24))
  })

  it('never shows a flight that waited too long', () => {
    const q = new FlightQueue()
    for (let i = 0; i < MAX_FLYING; i += 1) q.push(flight(`up${i}`), 0)
    q.update(0)
    q.push(flight('late'), 0)
    // Every seat was full for longer than a flight is worth showing.
    q.update(FLIGHT_MS - 1)
    const after = q.update(STALE_MS + 1)
    expect(after.started).toEqual([])
    expect(after.flying).toEqual([])
  })

  it('shows one that has waited exactly as long as allowed', () => {
    const q = new FlightQueue()
    for (let i = 0; i < MAX_FLYING; i += 1) q.push(flight(`up${i}`), 0)
    q.update(0)
    q.push(flight('edge'), 0)
    // The others have landed by now, at exactly the limit.
    expect(q.update(STALE_MS).started.map((f) => f.key)).toEqual(['edge'])
  })

  it('forgets everything when cleared', () => {
    const q = new FlightQueue()
    for (let i = 0; i < MAX_FLYING + 2; i += 1) q.push(flight(`f${i}`), 0)
    q.update(0)
    q.clear()
    expect(q.update(1)).toEqual({ started: [], flying: [] })
  })
})

describe('flightPoint', () => {
  const from = { x: 0, y: 0, z: 1 }
  const to = { x: 4, y: 2, z: 0.5 }

  it('starts and ends exactly at its ends', () => {
    expect(flightPoint(from, to, 0)).toEqual(from)
    const end = flightPoint(from, to, 1)
    expect(end.x).toBeCloseTo(4)
    expect(end.y).toBeCloseTo(2)
    expect(end.z).toBeCloseTo(0.5)
  })

  it('is lifted above the line between them at the middle by the arc height', () => {
    const mid = flightPoint(from, to, 0.5)
    expect(mid.x).toBeCloseTo(2)
    expect(mid.y).toBeCloseTo(1)
    expect(mid.z).toBeCloseTo(0.75 + ARC_HEIGHT)
  })

  it('stays put outside 0 to 1', () => {
    expect(flightPoint(from, to, -1)).toEqual(from)
    expect(flightPoint(from, to, 2).x).toBeCloseTo(4)
  })
})

describe('ease', () => {
  it('is slow at the ends and moves steadily on', () => {
    expect(ease(0)).toBe(0)
    expect(ease(1)).toBe(1)
    expect(ease(0.5)).toBeCloseTo(0.5)
    expect(ease(0.1)).toBeLessThan(0.1)
    expect(ease(0.9)).toBeGreaterThan(0.9)
    const samples = [0, 0.2, 0.4, 0.6, 0.8, 1].map(ease)
    expect([...samples].sort((a, b) => a - b)).toEqual(samples)
  })
})
