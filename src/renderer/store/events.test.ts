import { beforeEach, describe, expect, it } from 'vitest'
import type { ShokubaEvent } from '@shared/events/schema'
import { useEvents } from './events'

const ev = (seq: number): ShokubaEvent => ({
  type: 'app.stopping',
  source: 'system',
  payload: {},
  seq,
  id: `id${seq}`,
  ts: '2026-09-19T10:00:00.000Z',
})

beforeEach(() => useEvents.setState({ events: [] }))

describe('useEvents', () => {
  it('keeps events ordered by seq even when they arrive out of order', () => {
    useEvents.getState().ingest([ev(3), ev(1)])
    useEvents.getState().ingest([ev(2)])
    expect(useEvents.getState().events.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('drops duplicates from the subscribe-then-list race', () => {
    useEvents.getState().ingest([ev(1), ev(2)])
    useEvents.getState().ingest([ev(2), ev(3)])
    expect(useEvents.getState().events.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('keeps only the most recent 500 events', () => {
    useEvents.getState().ingest(Array.from({ length: 600 }, (_, i) => ev(i + 1)))
    const events = useEvents.getState().events
    expect(events).toHaveLength(500)
    expect(events[0]?.seq).toBe(101)
    expect(events.at(-1)?.seq).toBe(600)
  })
})
