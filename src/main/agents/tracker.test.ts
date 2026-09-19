import { describe, expect, it } from 'vitest'
import type { AgentSignal, ToolActivity } from '../providers/types'
import { AgentTracker, type TrackerOutput } from './tracker'

const CODING: ToolActivity = { state: 'coding', inferred: false }
const SHELL: ToolActivity = { state: 'coding', inferred: true }
const TESTING: ToolActivity = { state: 'testing', inferred: true }

function tracker(source: 'reported' | 'simulated' = 'reported'): AgentTracker {
  const t = new AgentTracker('e1', source)
  t.start()
  return t
}

const types = (outputs: TrackerOutput[]): string[] => outputs.map((o) => o.type)
const transitions = (outputs: TrackerOutput[]): string[] =>
  outputs
    .filter((o) => o.type === 'agent.state.changed')
    .map((o) => (o.type === 'agent.state.changed' ? `${o.payload.from}>${o.payload.to}` : ''))

const toolStart = (id: string, activity: ToolActivity = CODING, name = 'Edit'): AgentSignal => ({
  kind: 'tool-started',
  toolUseId: id,
  toolName: name,
  summary: `${name} thing`,
  activity,
})
const toolEnd = (id: string, name = 'Edit'): AgentSignal => ({
  kind: 'tool-finished',
  toolUseId: id,
  toolName: name,
  ok: true,
})

describe('AgentTracker lifecycle', () => {
  it('starts offline and moves to starting on launch', () => {
    const t = new AgentTracker('e1', 'reported')
    expect(t.state).toBe('offline')
    expect(transitions(t.start())).toEqual(['offline>starting'])
    expect(t.state).toBe('starting')
  })

  it('becomes ready and idle on SessionStart', () => {
    const t = tracker()
    const out = t.onSignal({ kind: 'session-started' })
    expect(types(out)).toEqual(['agent.ready', 'agent.state.changed'])
    expect(t.state).toBe('idle')
  })

  it('treats the first report of any kind as proof the agent is up', () => {
    const t = tracker()
    const out = t.onSignal({ kind: 'turn-started' })
    expect(transitions(out)).toEqual(['starting>idle', 'idle>thinking'])
    expect(types(out)).toContain('agent.ready')
  })

  it('walks a normal turn: thinking, working with tools, back to thinking, idle', () => {
    const t = tracker()
    t.onSignal({ kind: 'session-started' })
    expect(transitions(t.onSignal({ kind: 'turn-started' }))).toEqual(['idle>thinking'])
    expect(transitions(t.onSignal(toolStart('a', CODING)))).toEqual(['thinking>coding'])
    expect(transitions(t.onSignal(toolEnd('a')))).toEqual(['coding>thinking'])
    expect(transitions(t.onSignal({ kind: 'turn-finished' }))).toEqual(['thinking>idle'])
    expect(t.state).toBe('idle')
  })

  it('does not emit a state change when the state is unchanged', () => {
    const t = tracker()
    t.onSignal({ kind: 'turn-started' })
    t.onSignal(toolStart('a', CODING))
    const out = t.onSignal(toolStart('b', CODING, 'Write'))
    expect(transitions(out)).toEqual([])
    expect(types(out)).toEqual(['agent.tool.started'])
  })

  it('exits: stopped when clean, error when not', () => {
    const clean = tracker()
    clean.onSignal({ kind: 'session-started' })
    expect(transitions(clean.exited(true, 'stopped by the user'))).toEqual(['idle>stopped'])

    const crashed = tracker()
    crashed.onSignal({ kind: 'session-started' })
    expect(transitions(crashed.exited(false, 'exited with code 1'))).toEqual(['idle>error'])
  })

  it('can be started again after stopping', () => {
    const t = tracker()
    t.exited(true, 'done')
    expect(transitions(t.start())).toEqual(['stopped>starting'])
  })
})

describe('AgentTracker tools', () => {
  it('stays busy until the last of several parallel tools finishes', () => {
    const t = tracker()
    t.onSignal({ kind: 'turn-started' })
    t.onSignal(toolStart('a', CODING, 'Edit'))
    t.onSignal(toolStart('b', { state: 'researching', inferred: false }, 'Read'))
    expect(t.state).toBe('researching')

    // Finishing the newer one falls back to what the older one implies.
    expect(transitions(t.onSignal(toolEnd('b', 'Read')))).toEqual(['researching>coding'])
    expect(transitions(t.onSignal(toolEnd('a', 'Edit')))).toEqual(['coding>thinking'])
  })

  it('handles tool ids being absent', () => {
    const t = tracker()
    t.onSignal({ kind: 'turn-started' })
    t.onSignal({ kind: 'tool-started', toolName: 'Bash', summary: 'Run ls', activity: SHELL })
    expect(t.state).toBe('coding')
    t.onSignal({ kind: 'tool-finished', toolName: 'Bash', ok: true })
    expect(t.state).toBe('thinking')
  })

  it('labels shell-command classifications as inferred and tool-name ones as reported', () => {
    const t = tracker()
    t.onSignal({ kind: 'turn-started' })
    const edit = t.onSignal(toolStart('a', CODING))
    expect(edit.find((o) => o.type === 'agent.state.changed')?.source).toBe('reported')
    t.onSignal(toolEnd('a'))
    const test = t.onSignal(toolStart('b', TESTING, 'Bash'))
    expect(test.find((o) => o.type === 'agent.state.changed')?.source).toBe('inferred')
    // The tool event itself is a fact the agent reported.
    expect(test.find((o) => o.type === 'agent.tool.started')?.source).toBe('reported')
  })

  it('carries tool details on the events', () => {
    const t = tracker()
    t.onSignal({ kind: 'turn-started' })
    const out = t.onSignal({
      kind: 'tool-finished',
      toolUseId: 'x',
      toolName: 'Bash',
      ok: false,
      durationMs: 40,
    })
    expect(out[0]).toMatchObject({
      type: 'agent.tool.finished',
      actorId: 'e1',
      payload: { employeeId: 'e1', toolName: 'Bash', ok: false, durationMs: 40, toolUseId: 'x' },
    })
  })
})

describe('AgentTracker attention and errors', () => {
  it('waits for a human on a permission request, and resumes when the tool completes', () => {
    const t = tracker()
    t.onSignal({ kind: 'turn-started' })
    t.onSignal(toolStart('a', SHELL, 'Bash'))
    const out = t.onSignal({
      kind: 'attention',
      reason: 'permission',
      message: 'Needs permission to use Bash',
    })
    expect(types(out)).toEqual(['agent.attention', 'agent.state.changed'])
    expect(t.state).toBe('waiting')
    t.onSignal(toolEnd('a', 'Bash'))
    expect(t.state).toBe('thinking')
  })

  it('records a failed turn as an error, and recovers on the next prompt', () => {
    const t = tracker()
    t.onSignal({ kind: 'turn-started' })
    const out = t.onSignal({ kind: 'turn-failed', message: 'rate limited' })
    expect(types(out)).toEqual(['agent.error', 'agent.state.changed'])
    expect(t.state).toBe('error')
    t.onSignal({ kind: 'turn-started' })
    expect(t.state).toBe('thinking')
  })

  it('does not treat the end of a Claude session as the end of the agent', () => {
    const t = tracker()
    t.onSignal({ kind: 'turn-started' })
    t.onSignal({ kind: 'session-ended', reason: 'clear' })
    expect(t.state).toBe('idle')
    // ...and a following SessionStart (as /clear does) changes nothing.
    expect(t.onSignal({ kind: 'session-started' })).toEqual([])
  })
})

describe('AgentTracker interruption', () => {
  it('marks an interrupted turn idle, as an inference', () => {
    const t = tracker()
    t.onSignal({ kind: 'turn-started' })
    t.onSignal(toolStart('a', CODING))
    const out = t.interrupted()
    expect(transitions(out)).toEqual(['coding>idle'])
    expect(out[0]?.source).toBe('inferred')
  })

  it('is a no-op when nothing was running', () => {
    const t = tracker()
    t.onSignal({ kind: 'session-started' })
    expect(t.interrupted()).toEqual([])
    expect(t.state).toBe('idle')
  })

  it('is corrected by the next real signal', () => {
    const t = tracker()
    t.onSignal({ kind: 'turn-started' })
    t.interrupted()
    t.onSignal(toolStart('z', CODING))
    expect(t.state).toBe('coding')
  })
})

describe('AgentTracker labelling', () => {
  it('labels everything from the demo provider as simulated, never reported', () => {
    const t = tracker('simulated')
    const out = [
      ...t.onSignal({ kind: 'turn-started' }),
      ...t.onSignal(toolStart('a', CODING)),
      ...t.onSignal({ kind: 'turn-finished' }),
    ]
    const fromAgent = out.filter((o) => o.source !== 'inferred')
    expect(fromAgent.length).toBeGreaterThan(0)
    expect(fromAgent.every((o) => o.source === 'simulated')).toBe(true)
  })
})
