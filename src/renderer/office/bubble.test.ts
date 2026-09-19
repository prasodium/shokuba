import { describe, expect, it } from 'vitest'
import { initialView, type AgentView } from '@shared/agents/view'
import { STATE_LABELS, bubbleFor, provenance, toneOf } from './bubble'
import { RUNTIME_STATES } from '@shared/types/agent'

const view = (patch: Partial<AgentView>): AgentView => ({ ...initialView('e1', 't'), ...patch })

describe('bubbleFor', () => {
  it('shows an offline bubble for an unknown agent', () => {
    expect(bubbleFor(undefined)).toMatchObject({ label: 'Offline', tone: 'off', detail: null })
  })

  it('names the state and what the agent is doing', () => {
    const model = bubbleFor(
      view({
        state: 'coding',
        stateSource: 'reported',
        activity: { toolName: 'Edit', summary: 'Edit src/app.ts' },
      }),
    )
    expect(model).toMatchObject({
      label: 'Coding',
      detail: 'Edit src/app.ts',
      tone: 'busy',
      provenance: null,
    })
  })

  it('shows the reason a waiting agent needs a human', () => {
    const model = bubbleFor(view({ state: 'waiting', reason: 'Needs permission to use Bash' }))
    expect(model).toMatchObject({
      label: 'Needs you',
      detail: 'Needs permission to use Bash',
      tone: 'wait',
    })
  })

  it('shows the error message for an agent in error', () => {
    expect(bubbleFor(view({ state: 'error', error: 'rate limited' }))).toMatchObject({
      tone: 'error',
      detail: 'rate limited',
    })
  })

  it('truncates long details so the bubble stays small', () => {
    const model = bubbleFor(
      view({ state: 'coding', activity: { toolName: 'Bash', summary: 'x'.repeat(200) } }),
    )
    expect(model.detail?.length).toBeLessThanOrEqual(34)
    expect(model.detail?.endsWith('…')).toBe(true)
  })

  it('labels inferred and simulated states, and only those', () => {
    expect(bubbleFor(view({ state: 'testing', stateSource: 'inferred' })).provenance).toBe(
      'inferred',
    )
    expect(bubbleFor(view({ state: 'coding', stateSource: 'simulated' })).provenance).toBe('demo')
    expect(bubbleFor(view({ state: 'coding', stateSource: 'reported' })).provenance).toBeNull()
    expect(provenance('system')).toBeNull()
    expect(provenance('user')).toBeNull()
  })
})

describe('labels and tones', () => {
  it('cover every runtime state', () => {
    for (const state of RUNTIME_STATES) {
      expect(STATE_LABELS[state]).toBeTruthy()
      expect(toneOf(state)).toBeTruthy()
    }
  })

  it('treats a stopped agent as off and a waiting one as urgent', () => {
    expect(toneOf('stopped')).toBe('off')
    expect(toneOf('waiting')).toBe('wait')
    expect(toneOf('error')).toBe('error')
  })
})
