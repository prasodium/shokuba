import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EventInput, ShokubaEvent } from '@shared/events/schema'
import { openDatabase, type Db } from '../database/connection'
import { MIGRATIONS } from '../database/migrations'
import { migrate } from '../database/migrator'
import { AuditLog } from './audit'
import { EventBus } from './bus'
import { CorruptEventError, EventLog } from './log'
import { EventStore, InvalidEventError } from './store'

const open: Db[] = []
const freshDb = (): Db => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS)
  open.push(db)
  return db
}
afterEach(() => {
  while (open.length > 0) open.pop()?.close()
})

const ready = (employeeId: string, extra: Partial<EventInput> = {}): EventInput =>
  ({ type: 'agent.ready', source: 'reported', payload: { employeeId }, ...extra }) as EventInput

const stateChange = (employeeId: string, from: 'idle', to: 'coding'): EventInput => ({
  type: 'agent.state.changed',
  source: 'reported',
  payload: { employeeId, from, to },
})

describe('EventLog', () => {
  it('assigns increasing seq, an id and an ISO timestamp', () => {
    const log = new EventLog(freshDb(), () => new Date('2026-09-19T10:00:00.000Z'))
    const a = log.append(ready('alice'))
    const b = log.append(ready('bob'))
    expect(b.seq).toBe(a.seq + 1)
    expect(a.id).not.toBe(b.id)
    expect(a.ts).toBe('2026-09-19T10:00:00.000Z')
  })

  it('round-trips every envelope field and the payload', () => {
    const log = new EventLog(freshDb())
    const written = log.append(
      ready('alice', {
        actorId: 'alice',
        targetId: 'bob',
        missionId: 'm1',
        taskId: 't1',
        correlationId: 'c1',
        causationId: 'e0',
      }),
    )
    expect(log.list()).toEqual([written])
  })

  it('pages with afterSeq and limit', () => {
    const log = new EventLog(freshDb())
    for (const name of ['a', 'b', 'c', 'd']) log.append(ready(name))
    const firstPage = log.list({ limit: 2 })
    expect(firstPage.map((e) => e.seq)).toEqual([1, 2])
    const secondPage = log.list({ afterSeq: 2, limit: 2 })
    expect(secondPage.map((e) => e.seq)).toEqual([3, 4])
    expect(log.list({ afterSeq: 4 })).toEqual([])
  })

  it('filters by type, actor, task and mission', () => {
    const log = new EventLog(freshDb())
    log.append(ready('alice', { actorId: 'alice', taskId: 't1', missionId: 'm1' }))
    log.append(stateChange('alice', 'idle', 'coding'))
    log.append(ready('bob', { actorId: 'bob', taskId: 't2', missionId: 'm1' }))

    expect(log.list({ type: 'agent.state.changed' })).toHaveLength(1)
    expect(log.list({ actorId: 'bob' })).toHaveLength(1)
    expect(log.list({ taskId: 't1' })).toHaveLength(1)
    expect(log.list({ missionId: 'm1' })).toHaveLength(2)
  })

  it('reports count and latest seq', () => {
    const log = new EventLog(freshDb())
    expect(log.count()).toBe(0)
    expect(log.latestSeq()).toBe(0)
    log.append(ready('a'))
    log.append(ready('b'))
    expect(log.count()).toBe(2)
    expect(log.latestSeq()).toBe(2)
  })

  it('never reuses a seq, even after a rolled-back insert', () => {
    const db = freshDb()
    const log = new EventLog(db)
    const first = log.append(ready('a'))
    try {
      db.transaction(() => {
        log.append(ready('b'))
        throw new Error('abort')
      })()
    } catch {
      // expected
    }
    const next = log.append(ready('c'))
    expect(next.seq).toBeGreaterThan(first.seq)
  })

  it('refuses to read a row that no longer matches its schema', () => {
    const db = freshDb()
    db.prepare(
      "INSERT INTO agent_events (id, ts, type, source, payload) VALUES ('x', 't', 'agent.ready', 'reported', '{}')",
    ).run()
    expect(() => new EventLog(db).list()).toThrow(CorruptEventError)
  })
})

describe('EventBus', () => {
  const event = (
    seq: number,
    type: 'agent.ready' | 'app.stopping' = 'agent.ready',
  ): ShokubaEvent =>
    type === 'agent.ready'
      ? { type, source: 'system', payload: { employeeId: `e${seq}` }, seq, id: `id${seq}`, ts: 't' }
      : { type, source: 'system', payload: {}, seq, id: `id${seq}`, ts: 't' }

  it('delivers to type-specific and catch-all listeners', () => {
    const bus = new EventBus()
    const typed = vi.fn()
    const any = vi.fn()
    bus.on('agent.ready', typed)
    bus.onAny(any)
    bus.emit(event(1))
    bus.emit(event(2, 'app.stopping'))
    expect(typed).toHaveBeenCalledTimes(1)
    expect(any).toHaveBeenCalledTimes(2)
  })

  it('narrows the payload type for typed listeners', () => {
    const bus = new EventBus()
    const seen: string[] = []
    bus.on('agent.ready', (e) => seen.push(e.payload.employeeId))
    bus.emit(event(7))
    expect(seen).toEqual(['e7'])
  })

  it('stops delivering after unsubscribe', () => {
    const bus = new EventBus()
    const listener = vi.fn()
    const off = bus.on('agent.ready', listener)
    off()
    bus.emit(event(1))
    expect(listener).not.toHaveBeenCalled()
  })

  it('isolates a throwing listener: others still run and the error is reported', () => {
    const onError = vi.fn()
    const bus = new EventBus(onError)
    const after = vi.fn()
    bus.on('agent.ready', () => {
      throw new Error('bad listener')
    })
    bus.on('agent.ready', after)
    expect(() => bus.emit(event(1))).not.toThrow()
    expect(after).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('survives an error handler that itself throws', () => {
    const bus = new EventBus(() => {
      throw new Error('handler failed too')
    })
    const after = vi.fn()
    bus.on('agent.ready', () => {
      throw new Error('bad listener')
    })
    bus.on('agent.ready', after)
    expect(() => bus.emit(event(1))).not.toThrow()
    expect(after).toHaveBeenCalled()
  })

  it('keeps FIFO order when a listener publishes during delivery', () => {
    const bus = new EventBus()
    const order: string[] = []
    bus.on('agent.ready', (e) => {
      order.push(`first:${e.seq}`)
      if (e.seq === 1) bus.emit(event(2))
    })
    bus.on('agent.ready', (e) => order.push(`second:${e.seq}`))
    bus.emit(event(1))
    // Event 1 reaches *both* listeners before event 2 is delivered to anyone.
    expect(order).toEqual(['first:1', 'second:1', 'first:2', 'second:2'])
  })

  it('lets a listener unsubscribe itself mid-dispatch', () => {
    const bus = new EventBus()
    const calls: number[] = []
    const off = bus.on('agent.ready', (e) => {
      calls.push(e.seq)
      off()
    })
    bus.emit(event(1))
    bus.emit(event(2))
    expect(calls).toEqual([1])
  })
})

describe('EventStore', () => {
  const build = () => {
    const db = freshDb()
    const bus = new EventBus()
    const log = new EventLog(db)
    return { db, bus, log, store: new EventStore(log, bus) }
  }

  it('persists, then broadcasts the persisted event', () => {
    const { store, bus, log } = build()
    const received: ShokubaEvent[] = []
    bus.onAny((e) => received.push(e))
    const published = store.publish(ready('alice'))
    expect(received).toEqual([published])
    expect(log.list()).toEqual([published])
  })

  it('has already persisted the event by the time a subscriber sees it', () => {
    const { store, bus, log } = build()
    let countSeenBySubscriber = -1
    bus.onAny(() => {
      countSeenBySubscriber = log.count()
    })
    store.publish(ready('alice'))
    expect(countSeenBySubscriber).toBe(1)
  })

  it('takes a GitHub import as numbers only, and refuses any text with it', () => {
    const { store } = build()
    const ok = {
      type: 'github.issue.imported',
      source: 'user',
      missionId: 'm1',
      payload: { missionId: 'm1', repo: 'octo/widgets', number: 7 },
    } as const
    expect(() => store.publish(ok)).not.toThrow()
    const withText = { ...ok, payload: { ...ok.payload, title: 'Fix it' } }
    expect(() => store.publish(withText as unknown as EventInput)).toThrow(InvalidEventError)
    for (const number of [0, -1, 1.5]) {
      const bad = { ...ok, payload: { ...ok.payload, number } }
      expect(() => store.publish(bad), String(number)).toThrow(InvalidEventError)
    }
  })

  it('rejects an invalid event and neither persists nor broadcasts it', () => {
    const { store, bus, log } = build()
    const listener = vi.fn()
    bus.onAny(listener)
    const bad = { type: 'agent.ready', source: 'reported', payload: {} } as unknown as EventInput
    expect(() => store.publish(bad)).toThrow(InvalidEventError)
    expect(log.count()).toBe(0)
    expect(listener).not.toHaveBeenCalled()
  })

  it('rejects unknown event types and unexpected fields', () => {
    const { store } = build()
    expect(() =>
      store.publish({ type: 'nope', source: 'system', payload: {} } as unknown as EventInput),
    ).toThrow(InvalidEventError)
    expect(() =>
      store.publish({
        type: 'app.stopping',
        source: 'system',
        payload: {},
        surprise: true,
      } as unknown as EventInput),
    ).toThrow(InvalidEventError)
  })

  it('does not broadcast when persisting fails', () => {
    const { store, bus, db } = build()
    const listener = vi.fn()
    bus.onAny(listener)
    db.exec('DROP TABLE agent_events') // simulate a broken database
    expect(() => store.publish(ready('alice'))).toThrow()
    expect(listener).not.toHaveBeenCalled()
  })

  it('redacts secrets before they reach the log or subscribers', () => {
    const { store, log } = build()
    const secret = 'sk-' + 'ant-' + 'x'.repeat(30)
    const published = store.publish({
      type: 'agent.error',
      source: 'reported',
      payload: { employeeId: 'alice', code: 'auth', message: `rejected key ${secret}` },
    })
    const stored = JSON.stringify(log.list())
    expect(stored).not.toContain(secret)
    expect(stored).toContain('[REDACTED:anthropic-key]')
    expect(JSON.stringify(published)).not.toContain(secret)
  })

  it('rejects, rather than stores, a message that only overflows because redaction lengthened it', () => {
    const { store, log } = build()
    // 1979 padding + " password=abcdef" (16) = 1995 chars: under the 2000 limit as supplied.
    // Redacting the 6-char secret to "[REDACTED:secret-assignment]" adds 22 chars -> 2017.
    const message = `${'a'.repeat(1979)} password=abcdef`
    expect(message.length).toBe(1995)

    const publish = () =>
      store.publish({
        type: 'agent.error',
        source: 'reported',
        payload: { employeeId: 'alice', code: 'x', message },
      })

    // Validating the *redacted* data means we refuse it up front instead of writing a row
    // that would fail validation when read back.
    expect(publish).toThrow(InvalidEventError)
    expect(log.count()).toBe(0)
    expect(() => log.list()).not.toThrow()
  })
})

describe('AuditLog', () => {
  it('records entries with redacted detail and returns them in order', () => {
    const audit = new AuditLog(freshDb(), () => new Date('2026-09-19T10:00:00.000Z'))
    audit.record({ actor: 'system', action: 'app.start', detail: { version: '0.0.1' } })
    audit.record({
      actor: 'user',
      action: 'settings.change',
      target: 'budget',
      detail: { apiKey: 'plain' },
    })
    const records = audit.list()
    expect(records.map((r) => r.action)).toEqual(['app.start', 'settings.change'])
    expect(records[1]?.detail).toEqual({ apiKey: '[REDACTED:sensitive-key]' })
    expect(records[0]?.ts).toBe('2026-09-19T10:00:00.000Z')
  })

  it('rejects entries without an actor or action', () => {
    const audit = new AuditLog(freshDb())
    expect(() => audit.record({ actor: '', action: 'x' })).toThrow()
    expect(() => audit.record({ actor: 'x', action: '' })).toThrow()
  })
})
