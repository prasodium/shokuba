import { describe, expect, it } from 'vitest'
import { initialView, type AgentView } from '@shared/agents/view'
import { dispatchHint } from './hints'

const view = (patch: Partial<AgentView>): AgentView => ({
  ...initialView('e', 't'),
  pid: 42,
  ...patch,
})
const ready = { status: 'ready', assigneeId: 'e' } as const
const running = { status: 'running' } as const

describe('dispatchHint', () => {
  it('says nothing about tasks that are not waiting to go out', () => {
    for (const status of [
      'pending',
      'in_progress',
      'submitted',
      'blocked',
      'done',
      'cancelled',
    ] as const) {
      expect(
        dispatchHint({ status, assigneeId: 'e' }, running, 'Mika', view({ state: 'idle' })),
      ).toBeNull()
    }
  })

  it('explains a mission that is not running', () => {
    expect(dispatchHint(ready, { status: 'draft' }, 'Mika', undefined)).toMatch(/run the mission/)
    expect(dispatchHint(ready, { status: 'paused' }, 'Mika', undefined)).toMatch(/paused/)
    expect(dispatchHint(ready, { status: 'completed' }, 'Mika', undefined)).toBeNull()
  })

  it('asks for an assignee', () => {
    expect(dispatchHint({ status: 'ready', assigneeId: null }, running, null, undefined)).toMatch(
      /Assign someone/,
    )
  })

  it('says when the assignee is not running, or still starting', () => {
    expect(dispatchHint(ready, running, 'Mika', view({ pid: null, state: 'offline' }))).toMatch(
      /not running/,
    )
    expect(dispatchHint(ready, running, 'Mika', undefined)).toMatch(/not running/)
    expect(dispatchHint(ready, running, 'Mika', view({ state: 'starting' }))).toMatch(/starting up/)
  })

  it('says when the circuit breaker is holding the task back, and why', () => {
    const limited = view({
      state: 'idle',
      stateSource: 'reported',
      breakerLevel: 'constrain',
      breakerReason: 'the same call (Run npm test) 8 times in a row',
    })
    expect(dispatchHint(ready, running, 'Mika', limited)).toBe(
      'Mika is limited by the circuit breaker (the same call (Run npm test) 8 times in a row). Reset them to send it.',
    )
    expect(dispatchHint(ready, running, 'Mika', { ...limited, breakerLevel: 'pause' })).toMatch(
      /paused by the circuit breaker/,
    )
    // A warning restricts nothing, so it does not hold anything back.
    expect(dispatchHint(ready, running, 'Mika', { ...limited, breakerLevel: 'warning' })).toMatch(
      /Sending to Mika/,
    )
  })

  it('tells a person when the agent is waiting on them', () => {
    expect(dispatchHint(ready, running, 'Mika', view({ state: 'waiting' }))).toMatch(
      /permission prompt/,
    )
  })

  it('says the agent is busy and the task will follow', () => {
    expect(dispatchHint(ready, running, 'Mika', view({ state: 'coding' }))).toMatch(
      /busy \(coding\)/,
    )
  })

  it('is honest that an inferred idle is only a guess, and so nothing is sent yet', () => {
    expect(
      dispatchHint(ready, running, 'Mika', view({ state: 'idle', stateSource: 'inferred' })),
    ).toMatch(/only a guess/)
  })

  it('says it is sending when the agent is reported idle (real or demo)', () => {
    expect(
      dispatchHint(ready, running, 'Mika', view({ state: 'idle', stateSource: 'reported' })),
    ).toMatch(/Sending to Mika/)
    expect(
      dispatchHint(ready, running, 'Mika', view({ state: 'idle', stateSource: 'simulated' })),
    ).toMatch(/Sending to Mika/)
  })

  it('treats a sent-back task the same way as a ready one', () => {
    expect(
      dispatchHint(
        { status: 'changes_requested', assigneeId: 'e' },
        running,
        'Mika',
        view({ state: 'thinking' }),
      ),
    ).toMatch(/busy/)
  })
})
