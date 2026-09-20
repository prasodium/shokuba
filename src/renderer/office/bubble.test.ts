import { describe, expect, it } from 'vitest'
import { initialView, type AgentView } from '@shared/agents/view'
import {
  AWAY_NOTES,
  BREAKER_HELP,
  BREAKER_LABELS,
  STATE_LABELS,
  bubbleFor,
  provenance,
  toneOf,
} from './bubble'
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

describe('the circuit breaker in the office', () => {
  const running = { pid: 42, state: 'coding' as const }

  it('says nothing for an agent that is normal or only warned', () => {
    expect(bubbleFor(view({ ...running, breakerLevel: 'normal' })).caution).toBeNull()
    expect(bubbleFor(view({ ...running, breakerLevel: 'warning' })).caution).toBeNull()
  })

  it('marks a limited or paused agent, and turns its bubble amber', () => {
    expect(bubbleFor(view({ ...running, breakerLevel: 'constrain' }))).toMatchObject({
      caution: 'limited',
      tone: 'wait',
    })
    expect(bubbleFor(view({ ...running, breakerLevel: 'pause' }))).toMatchObject({
      caution: 'paused',
      tone: 'wait',
    })
  })

  it('still says what the agent is doing, and keeps a real error red', () => {
    const model = bubbleFor(
      view({
        ...running,
        breakerLevel: 'constrain',
        activity: { toolName: 'Edit', summary: 'Edit src/a.ts' },
      }),
    )
    expect(model).toMatchObject({ label: 'Coding', detail: 'Edit src/a.ts' })
    expect(bubbleFor(view({ pid: 42, state: 'error', breakerLevel: 'pause' })).tone).toBe('error')
  })

  it('does not mark an agent that is no longer running', () => {
    expect(
      bubbleFor(view({ pid: null, state: 'offline', breakerLevel: 'pause' })).caution,
    ).toBeNull()
  })

  it('explains every level in words', () => {
    for (const level of ['warning', 'constrain', 'pause', 'stop'] as const) {
      expect(BREAKER_LABELS[level]).toBeTruthy()
      expect(BREAKER_HELP[level]).toBeTruthy()
    }
  })
})

describe('someone who is away from their desk', () => {
  const testing = (source: 'reported' | 'inferred' | 'simulated' | 'system') =>
    view({
      state: 'testing',
      stateSource: source,
      activity: { toolName: 'Bash', summary: 'npm test' },
    })

  it('says where they are, instead of what they are running', () => {
    const away = bubbleFor(testing('inferred'), 'qa')
    expect(away.detail).toBe('at the QA bench')
    expect(away.label).toBe('Testing')
    expect(bubbleFor(testing('inferred'), null).detail).toBe('npm test')
    expect(bubbleFor(testing('inferred')).detail).toBe('npm test')
  })

  it('is always marked as our reading of what the agent is doing, even if the state was reported', () => {
    expect(bubbleFor(testing('reported'), 'qa').provenance).toBe('inferred')
    expect(bubbleFor(testing('inferred'), 'qa').provenance).toBe('inferred')
    expect(bubbleFor(testing('system'), 'qa').provenance).toBe('inferred')
  })

  it('leaves a demo marked as a demo, since nothing in it is real', () => {
    expect(bubbleFor(testing('simulated'), 'qa').provenance).toBe('demo')
  })

  it('carries only the state’s own label when the trip is a recorded fact, like a review', () => {
    const reviewing = (source: 'reported' | 'inferred' | 'simulated' | 'system') =>
      view({ state: 'thinking', stateSource: source, activity: null })
    const away = bubbleFor(reviewing('reported'), 'reading', 'recorded')
    expect(away.detail).toBe('in the reading room')
    expect(away.provenance).toBeNull()
    expect(away.simulated).toBe(false)
    // The state's own label still shows, and a demo is still a demo.
    expect(bubbleFor(reviewing('inferred'), 'reading', 'recorded').provenance).toBe('inferred')
    expect(bubbleFor(reviewing('simulated'), 'reading', 'recorded').provenance).toBe('demo')
    // Our reading (the default) is marked, as before.
    expect(bubbleFor(reviewing('reported'), 'reading', 'inferred').provenance).toBe('inferred')
    expect(bubbleFor(reviewing('reported'), 'reading').provenance).toBe('inferred')
  })

  describe('on a simulated break', () => {
    const idle = (source: 'reported' | 'inferred' | 'simulated' | 'system') =>
      view({ state: 'idle', stateSource: source, activity: null })

    it('says where they are and that it is simulated, and nothing about what their agent is doing', () => {
      const tea = bubbleFor(idle('reported'), 'tea', 'simulated')
      expect(tea.detail).toBe('at the tea corner')
      expect(tea.label).toBe('Idle')
      expect(tea.simulated).toBe(true)
      // The trip is not our reading of the agent, so it is not marked inferred.
      expect(tea.provenance).toBeNull()
      expect(bubbleFor(idle('reported'), 'snacks', 'simulated').detail).toBe('at the snack corner')
    })

    it('keeps the state’s own label as well, so a demo agent is still a demo', () => {
      const demo = bubbleFor(idle('simulated'), 'tea', 'simulated')
      expect(demo).toMatchObject({ provenance: 'demo', simulated: true })
    })

    it('can leave out where they are for a group already together, and keeps every mark', () => {
      const brief = bubbleFor(idle('reported'), 'meeting', 'simulated', true)
      expect(brief.detail).toBeNull()
      expect(brief).toMatchObject({ label: 'Idle', simulated: true })
      // Not brief (the default) says where, as before.
      expect(bubbleFor(idle('reported'), 'meeting', 'simulated').detail).toBe('in the meeting room')
      // Brief changes nothing for someone at their desk, whose bubble says what they are doing.
      const working = view({
        state: 'coding',
        stateSource: 'reported',
        activity: { toolName: 'Edit', summary: 'src/a.ts' },
      })
      expect(bubbleFor(working, null, 'inferred', true).detail).toBe('src/a.ts')
    })

    it('is marked only while they are away', () => {
      expect(bubbleFor(idle('reported'), null, 'simulated').simulated).toBe(false)
      expect(bubbleFor(idle('reported')).simulated).toBe(false)
      expect(bubbleFor(undefined, 'tea', 'simulated').simulated).toBe(false)
    })

    it('is never claimed for a trip that is not simulated', () => {
      for (const trip of ['inferred', 'recorded'] as const) {
        expect(bubbleFor(idle('reported'), 'tea', trip).simulated, trip).toBe(false)
      }
    })
  })

  it('does not mark someone at their desk any differently than before', () => {
    expect(bubbleFor(testing('reported')).provenance).toBeNull()
    expect(bubbleFor(testing('simulated')).provenance).toBe('demo')
  })

  it('has a way of saying each kind of place, and keeps the tone and any caution', () => {
    expect(Object.keys(AWAY_NOTES).sort()).toEqual(
      ['board', 'chat', 'inbox', 'meeting', 'qa', 'reading', 'snacks', 'tea'].sort(),
    )
    for (const note of Object.values(AWAY_NOTES)) expect(note.length).toBeLessThanOrEqual(34)
    const limited = bubbleFor(
      view({ ...testing('inferred'), pid: 1, breakerLevel: 'constrain' }),
      'qa',
    )
    expect(limited).toMatchObject({ caution: 'limited', tone: 'wait', detail: 'at the QA bench' })
  })

  it('says nothing about a place for an agent nobody knows about', () => {
    expect(bubbleFor(undefined, 'qa').detail).toBeNull()
  })
})
