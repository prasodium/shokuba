import { describe, expect, it } from 'vitest'
import type { EventInput, ShokubaEvent } from '../events/schema'
import { applyEvent, buildViews, initialView } from './view'

let seq = 0
function ev(input: EventInput): ShokubaEvent {
  seq += 1
  return {
    ...input,
    seq,
    id: `id-${seq}`,
    ts: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
  }
}

const change = (
  employeeId: string,
  from: string,
  to: string,
  source: 'reported' | 'inferred' = 'reported',
) =>
  ev({
    type: 'agent.state.changed',
    source,
    payload: { employeeId, from: from as never, to: to as never },
  })

describe('applyEvent', () => {
  it('starts offline', () => {
    expect(initialView('e1', 'ts')).toMatchObject({ state: 'offline', pid: null, activity: null })
  })

  it('follows state changes and remembers how the state is known', () => {
    let view = initialView('e1', 't0')
    const event = change('e1', 'idle', 'coding', 'inferred')
    view = applyEvent(view, event)
    expect(view).toMatchObject({ state: 'coding', stateSource: 'inferred', since: event.ts })
  })

  it('returns the same object for events about other employees or other types', () => {
    const view = initialView('e1', 't0')
    expect(applyEvent(view, change('someone-else', 'idle', 'coding'))).toBe(view)
    expect(applyEvent(view, ev({ type: 'app.stopping', source: 'system', payload: {} }))).toBe(view)
  })

  it('tracks the current tool and clears it when the tool finishes', () => {
    let view = initialView('e1', 't0')
    view = applyEvent(
      view,
      ev({
        type: 'agent.tool.started',
        source: 'reported',
        payload: { employeeId: 'e1', toolName: 'Edit', summary: 'Edit a.ts' },
      }),
    )
    expect(view.activity).toEqual({ toolName: 'Edit', summary: 'Edit a.ts' })
    view = applyEvent(
      view,
      ev({
        type: 'agent.tool.finished',
        source: 'reported',
        payload: { employeeId: 'e1', toolName: 'Edit', ok: true },
      }),
    )
    expect(view.activity).toBeNull()
  })

  it('drops the tool when the agent goes idle or stops', () => {
    let view = initialView('e1', 't0')
    view = applyEvent(view, change('e1', 'idle', 'coding'))
    view = applyEvent(
      view,
      ev({
        type: 'agent.tool.started',
        source: 'reported',
        payload: { employeeId: 'e1', toolName: 'Edit', summary: 's' },
      }),
    )
    view = applyEvent(view, change('e1', 'coding', 'idle'))
    expect(view.activity).toBeNull()
  })

  it('records the process id and clears it on stop', () => {
    let view = initialView('e1', 't0')
    view = applyEvent(
      view,
      ev({ type: 'agent.started', source: 'system', payload: { employeeId: 'e1', pid: 99 } }),
    )
    expect(view.pid).toBe(99)
    view = applyEvent(
      view,
      ev({
        type: 'agent.stopped',
        source: 'system',
        payload: { employeeId: 'e1', exitCode: 0, signal: null },
      }),
    )
    expect(view.pid).toBeNull()
  })

  it('keeps an error message while in error and clears it when the agent recovers', () => {
    let view = initialView('e1', 't0')
    view = applyEvent(
      view,
      ev({
        type: 'agent.error',
        source: 'reported',
        payload: { employeeId: 'e1', code: 'x', message: 'boom' },
      }),
    )
    view = applyEvent(view, change('e1', 'thinking', 'error'))
    expect(view.error).toBe('boom')
    view = applyEvent(view, change('e1', 'error', 'thinking'))
    expect(view.error).toBeNull()
  })
})

describe('buildViews', () => {
  it('folds an ordered event list into per-employee views', () => {
    const events = [
      change('a', 'offline', 'starting'),
      change('b', 'offline', 'starting'),
      change('a', 'starting', 'idle'),
    ]
    const views = buildViews(['a', 'b'], events, 'now')
    expect(views.get('a')?.state).toBe('idle')
    expect(views.get('b')?.state).toBe('starting')
  })
})
