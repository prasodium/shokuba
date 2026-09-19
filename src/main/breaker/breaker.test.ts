import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EventInput } from '@shared/events/schema'
import { createLogger } from '../logging/logger'
import { createMissionFixture, type MissionFixture } from '../missions/fixtures'
import { CircuitBreaker } from './breaker'

const MIN = 60_000

let fx: MissionFixture
let breaker: CircuitBreaker
let clock: number
let interrupted: string[]
let stopped: string[]
let running: Set<string>
let participants: Record<string, string[]>

beforeEach(() => {
  fx = createMissionFixture()
  clock = 1_000_000
  interrupted = []
  stopped = []
  running = new Set(['mika', 'ren'])
  participants = {}
  breaker = new CircuitBreaker({
    events: fx.services.events,
    audit: fx.services.audit,
    logger: createLogger(() => {}),
    port: {
      isRunning: (id) => running.has(id),
      interrupt: (id) => void interrupted.push(id),
      stop: async (id) => void stopped.push(id),
    },
    participants: (id) => participants[id] ?? [],
    now: () => clock,
  })
  breaker.start()
})

afterEach(() => {
  breaker.stop()
  fx.cleanup()
})

function publish(input: EventInput): void {
  fx.services.events.publish(input)
}

const call = (id: string, tool: string, summary: string, toolUseId?: string): void =>
  publish({
    type: 'agent.tool.started',
    source: 'reported',
    payload: { employeeId: id, toolName: tool, summary, ...(toolUseId && { toolUseId }) },
  })
const finish = (id: string, ok: boolean, tool = 'Bash', toolUseId?: string): void =>
  publish({
    type: 'agent.tool.finished',
    source: 'reported',
    payload: { employeeId: id, toolName: tool, ok, ...(toolUseId && { toolUseId }) },
  })
const repeat = (id: string, times: number, summary = 'Run npm test'): void => {
  for (let i = 0; i < times; i++) call(id, 'Bash', summary)
}
const changes = (): string[] =>
  fx
    .eventsOf('breaker.state.changed')
    .map((e) =>
      e.type === 'breaker.state.changed'
        ? `${e.payload.from}>${e.payload.to}:${e.payload.rule}`
        : '',
    )

describe('escalation', () => {
  it('starts normal, and stays normal for ordinary work', () => {
    repeat('mika', 4)
    call('mika', 'Edit', 'Edit src/a.ts')
    expect(breaker.stateOf('mika')).toEqual({ level: 'normal', rule: null, detail: null })
    expect(changes()).toEqual([])
  })

  it('warns, then constrains, then pauses as the same call repeats', () => {
    repeat('mika', 5)
    expect(breaker.stateOf('mika')).toMatchObject({ level: 'warning', rule: 'repeated-call' })
    expect(breaker.stateOf('mika').detail).toBe('the same call (Run npm test) 5 times in a row')
    repeat('mika', 3)
    expect(breaker.levelOf('mika')).toBe('constrain')
    repeat('mika', 4)
    expect(breaker.levelOf('mika')).toBe('pause')
    expect(changes()).toEqual([
      'normal>warning:repeated-call',
      'warning>constrain:repeated-call',
      'constrain>pause:repeated-call',
    ])
  })

  it('only judges the agent that is misbehaving', () => {
    repeat('mika', 12)
    expect(breaker.levelOf('ren')).toBe('normal')
  })

  it('records who decided: the system, for an automatic change', () => {
    repeat('mika', 5)
    expect(fx.eventsOf('breaker.state.changed')[0]).toMatchObject({
      source: 'system',
      actorId: 'mika',
    })
  })

  it('never lowers a level by itself as the agent carries on', () => {
    repeat('mika', 8)
    call('mika', 'Edit', 'Edit src/a.ts')
    call('mika', 'Read', 'Read src/b.ts')
    expect(breaker.levelOf('mika')).toBe('constrain')
  })

  it('interrupts the running turn when it reaches pause, and only then', () => {
    repeat('mika', 11)
    expect(interrupted).toEqual([])
    repeat('mika', 1)
    expect(interrupted).toEqual(['mika'])
  })

  it('does not try to interrupt an agent that is not running', () => {
    running.delete('mika')
    repeat('mika', 12)
    expect(breaker.levelOf('mika')).toBe('pause')
    expect(interrupted).toEqual([])
  })

  it('leaves an audit entry for each change', () => {
    repeat('mika', 5)
    const row = fx.services.db
      .prepare("SELECT actor, target FROM audit_log WHERE action = 'breaker.warning'")
      .get() as { actor: string; target: string }
    expect(row).toEqual({ actor: 'system', target: 'mika' })
  })

  it('escalates on failed calls in a row, and a success in between starts the run again', () => {
    for (let i = 0; i < 6; i++) finish('mika', false)
    expect(breaker.stateOf('mika')).toMatchObject({ level: 'warning', rule: 'failed-calls' })
    const other = 'ren'
    for (let i = 0; i < 5; i++) finish(other, false)
    finish(other, true)
    for (let i = 0; i < 5; i++) finish(other, false)
    expect(breaker.levelOf(other)).toBe('normal')
  })

  it('escalates on turns that ended in an error', () => {
    for (let i = 0; i < 2; i++) {
      publish({
        type: 'agent.error',
        source: 'reported',
        payload: { employeeId: 'mika', code: 'turn-failed', message: 'x' },
      })
    }
    expect(breaker.stateOf('mika')).toMatchObject({ level: 'warning', rule: 'failed-turns' })
  })

  it('ignores an error that was not a failed turn', () => {
    for (let i = 0; i < 5; i++) {
      publish({
        type: 'agent.error',
        source: 'system',
        payload: { employeeId: 'mika', code: 'exited', message: 'x' },
      })
    }
    expect(breaker.levelOf('mika')).toBe('normal')
  })

  it('escalates when too many different files are edited in one task, and a new task starts the count again', () => {
    for (let i = 0; i < 40; i++) call('mika', 'Write', `Edit src/file-${i}.ts`)
    expect(breaker.stateOf('mika')).toMatchObject({ level: 'warning', rule: 'file-changes' })
    breaker.reset('mika')
    publish({
      type: 'task.dispatched',
      source: 'system',
      payload: { taskId: 't', missionId: 'm', employeeId: 'mika', attempt: 1 },
    })
    for (let i = 0; i < 30; i++) call('mika', 'Write', `Edit src/other-${i}.ts`)
    expect(breaker.levelOf('mika')).toBe('normal')
  })

  it('flags both agents when a conversation between them is halted as a possible loop', () => {
    participants['conv-1'] = ['mika', 'ren']
    publish({
      type: 'conversation.status.changed',
      source: 'system',
      payload: { conversationId: 'conv-1', from: 'open', to: 'halted', reason: 'loop' },
    })
    expect(breaker.stateOf('mika')).toMatchObject({
      level: 'warning',
      rule: 'halted-conversations',
    })
    expect(breaker.stateOf('ren')).toMatchObject({ level: 'warning', rule: 'halted-conversations' })
    // A second halt within half an hour constrains them.
    publish({
      type: 'conversation.status.changed',
      source: 'system',
      payload: { conversationId: 'conv-1', from: 'open', to: 'halted' },
    })
    expect(breaker.levelOf('mika')).toBe('constrain')
  })

  it('never pauses on its own for a halted conversation or a long turn', () => {
    participants['c'] = ['mika']
    for (let i = 0; i < 10; i++) {
      publish({
        type: 'conversation.status.changed',
        source: 'system',
        payload: { conversationId: 'c', from: 'open', to: 'halted' },
      })
    }
    expect(breaker.levelOf('mika')).toBe('constrain')
  })
})

describe('time', () => {
  it('notices a turn that will not end', () => {
    publish({ type: 'agent.turn.started', source: 'reported', payload: { employeeId: 'mika' } })
    clock += 31 * MIN
    breaker.sweep()
    expect(breaker.stateOf('mika')).toMatchObject({ level: 'warning', rule: 'long-turn' })
    clock += 60 * MIN
    breaker.sweep()
    expect(breaker.levelOf('mika')).toBe('constrain')
    clock += 600 * MIN
    breaker.sweep()
    expect(breaker.levelOf('mika')).toBe('constrain') // never pauses for time alone
  })

  it('stops watching a turn once it ends', () => {
    publish({ type: 'agent.turn.started', source: 'reported', payload: { employeeId: 'mika' } })
    publish({ type: 'agent.turn.finished', source: 'reported', payload: { employeeId: 'mika' } })
    clock += 500 * MIN
    breaker.sweep()
    expect(breaker.levelOf('mika')).toBe('normal')
  })

  it('lets a warning fade after ten quiet minutes, but not a constraint', () => {
    for (let i = 0; i < 6; i++) finish('mika', false)
    finish('mika', true)
    repeat('ren', 8)
    expect(breaker.levelOf('mika')).toBe('warning')
    expect(breaker.levelOf('ren')).toBe('constrain')
    clock += 11 * MIN
    breaker.sweep()
    expect(breaker.levelOf('mika')).toBe('normal')
    expect(breaker.levelOf('ren')).toBe('constrain')
  })
})

describe('what is denied', () => {
  it('nothing, while the agent is normal or only warned', () => {
    repeat('mika', 5)
    expect(breaker.decide('mika', 'Bash', 'Run npm test')).toBeNull()
    expect(breaker.decide('ren', 'Bash', 'anything')).toBeNull()
  })

  it('when constrained: the looping call, and nothing else', () => {
    repeat('mika', 8)
    const reason = breaker.decide('mika', 'Bash', 'Run npm test', 'tu-1')
    expect(reason).toContain('circuit breaker')
    expect(reason).toContain('Do not repeat it')
    expect(reason).toContain('report_blocked')
    // A different call, or a different tool, is fine.
    expect(breaker.decide('mika', 'Bash', 'Run npm run lint')).toBeNull()
    expect(breaker.decide('mika', 'Read', 'Read README.md')).toBeNull()
    expect(breaker.decide('mika', 'Edit', 'Edit src/a.ts')).toBeNull()
  })

  it('stops refusing the call once the agent has moved on to something else', () => {
    repeat('mika', 8)
    call('mika', 'Edit', 'Edit src/a.ts')
    expect(breaker.decide('mika', 'Bash', 'Run npm test')).toBeNull()
  })

  it('when constrained by editing too many files: further edits, and nothing else', () => {
    for (let i = 0; i < 80; i++) call('mika', 'Write', `Edit src/file-${i}.ts`)
    expect(breaker.levelOf('mika')).toBe('constrain')
    expect(breaker.decide('mika', 'Write', 'Edit src/one-more.ts')).toContain('further edits')
    expect(breaker.decide('mika', 'Read', 'Read src/x.ts')).toBeNull()
    expect(breaker.decide('mika', 'Bash', 'Run npm test')).toBeNull()
  })

  it('when paused: every tool except the hand-back ones', () => {
    repeat('mika', 12)
    expect(breaker.decide('mika', 'Bash', 'Run ls')).toContain('paused you')
    expect(breaker.decide('mika', 'Read', 'Read x')).not.toBeNull()
    expect(breaker.decide('mika', 'mcp__shokuba__send_message', 'x')).not.toBeNull()
    for (const allowed of [
      'mcp__shokuba__submit_task',
      'mcp__shokuba__report_blocked',
      'mcp__shokuba__get_current_task',
    ]) {
      expect(breaker.decide('mika', allowed, allowed)).toBeNull()
    }
  })

  it('records each refusal, with the reason', () => {
    repeat('mika', 8)
    breaker.decide('mika', 'Bash', 'Run npm test')
    const denied = fx.eventsOf('breaker.denied')
    expect(denied).toHaveLength(1)
    expect(denied[0]?.payload).toMatchObject({ employeeId: 'mika', toolName: 'Bash' })
  })

  it('does not count a call it refused as a failure of the agent', () => {
    for (let i = 0; i < 80; i++) call('mika', 'Write', `Edit src/file-${i}.ts`)
    expect(breaker.levelOf('mika')).toBe('constrain')
    for (let i = 0; i < 20; i++) {
      const id = `tu-${i}`
      call('mika', 'Write', `Edit src/more-${i}.ts`, id)
      expect(breaker.decide('mika', 'Write', `Edit src/more-${i}.ts`, id)).not.toBeNull()
      finish('mika', false, 'Write', id) // what the runtime reports for a call that did not run
    }
    // Twenty "failures" that were all refusals must not have paused an agent that did nothing wrong.
    expect(breaker.stateOf('mika').rule).toBe('file-changes')
    expect(breaker.levelOf('mika')).toBe('constrain')
  })

  it('does count real failures that it did not cause', () => {
    for (let i = 0; i < 80; i++) call('mika', 'Write', `Edit src/file-${i}.ts`)
    for (let i = 0; i < 15; i++) finish('mika', false, 'Write', `real-${i}`)
    expect(breaker.stateOf('mika')).toMatchObject({ level: 'pause', rule: 'failed-calls' })
  })

  it('an agent that keeps retrying a refused call is paused', () => {
    repeat('mika', 8)
    for (let i = 0; i < 4; i++) {
      call('mika', 'Bash', 'Run npm test')
      expect(breaker.decide('mika', 'Bash', 'Run npm test')).not.toBeNull()
    }
    expect(breaker.levelOf('mika')).toBe('pause')
  })
})

describe('what the rest of Shokuba is told', () => {
  it('holds back new tasks once constrained', () => {
    expect(breaker.allowsTasks('mika')).toBe(true)
    repeat('mika', 5)
    expect(breaker.allowsTasks('mika')).toBe(true) // only warned
    repeat('mika', 3)
    expect(breaker.allowsTasks('mika')).toBe(false)
  })

  it('lets the person, but not other agents, reach a constrained agent; and no one reach a paused one', () => {
    expect(breaker.allowsDelivery('mika', false)).toBe(true)
    repeat('mika', 8)
    expect(breaker.allowsDelivery('mika', false)).toBe(false)
    expect(breaker.allowsDelivery('mika', true)).toBe(true)
    repeat('mika', 4)
    expect(breaker.allowsDelivery('mika', true)).toBe(false)
  })

  it('points a limited agent at its manager for help, not at the person, when it has one', () => {
    const reports = new CircuitBreaker({
      events: fx.services.events,
      audit: fx.services.audit,
      logger: createLogger(() => {}),
      port: { isRunning: () => false, interrupt: () => {}, stop: async () => {} },
      participants: () => [],
      contactFor: (id) => (id === 'ren' ? 'Mira' : 'human'),
      now: () => clock,
    })
    reports.start()
    for (let i = 0; i < 8; i++) call('ren', 'Bash', 'Run npm test')
    const reason = reports.messageBlocker('ren') ?? ''
    expect(reason).toContain('message your manager (to: "Mira")')
    expect(reason).not.toContain('to: "human"')
    reports.stop()
  })

  it('stops a constrained agent messaging its teammates, with a reason that says how to get help', () => {
    expect(breaker.messageBlocker('mika')).toBeNull()
    repeat('mika', 8)
    const reason = breaker.messageBlocker('mika') ?? ''
    expect(reason).toContain('circuit breaker')
    expect(reason).toContain('report_blocked')
    expect(reason).toContain('to: "human"')
  })
})

describe('what a person can do', () => {
  it('reset returns an agent to normal and forgets what tripped it', () => {
    repeat('mika', 8)
    breaker.reset('mika')
    expect(breaker.stateOf('mika')).toEqual({ level: 'normal', rule: null, detail: null })
    expect(fx.eventsOf('breaker.state.changed').at(-1)).toMatchObject({
      source: 'user',
      payload: { to: 'normal', rule: 'manual' },
    })
    // The old streak does not count any more.
    repeat('mika', 3)
    expect(breaker.levelOf('mika')).toBe('normal')
    expect(breaker.decide('mika', 'Bash', 'Run npm test')).toBeNull()
  })

  it('reset of an agent that is already normal does nothing', () => {
    const before = fx.eventsOf().length
    breaker.reset('mika')
    expect(fx.eventsOf()).toHaveLength(before)
  })

  it('pause pauses and interrupts, as the person', () => {
    breaker.pause('mika')
    expect(breaker.stateOf('mika')).toMatchObject({
      level: 'pause',
      rule: 'manual',
      detail: 'paused by you',
    })
    expect(interrupted).toEqual(['mika'])
    expect(fx.eventsOf('breaker.state.changed')[0]).toMatchObject({ source: 'user' })
    expect(breaker.decide('mika', 'Bash', 'anything')).not.toBeNull()
  })

  it('pause is idempotent, and does not lower a stop', async () => {
    breaker.pause('mika')
    breaker.pause('mika')
    expect(interrupted).toHaveLength(1)
    await breaker.stopAgent('ren')
    breaker.pause('ren')
    expect(breaker.levelOf('ren')).toBe('stop')
  })

  it('stop ends the process and records it', async () => {
    await breaker.stopAgent('mika')
    expect(stopped).toEqual(['mika'])
    expect(breaker.stateOf('mika')).toMatchObject({ level: 'stop', rule: 'manual' })
  })

  it('never reaches stop by itself, however badly an agent behaves', () => {
    // Far past every threshold (the highest is 15), so the point is made without persisting
    // hundreds of events, which is slow enough on a Windows runner to risk the default limit.
    repeat('mika', 60)
    for (let i = 0; i < 60; i++) finish('mika', false)
    expect(breaker.levelOf('mika')).toBe('pause')
    expect(stopped).toEqual([])
  }, 30_000)

  it('a restart gives the agent a clean slate, and says so', () => {
    repeat('mika', 12)
    publish({ type: 'agent.started', source: 'system', payload: { employeeId: 'mika', pid: 1 } })
    expect(breaker.stateOf('mika').level).toBe('normal')
    expect(fx.eventsOf('breaker.state.changed').at(-1)).toMatchObject({
      payload: { to: 'normal', rule: 'restarted' },
    })
    repeat('mika', 3)
    expect(breaker.levelOf('mika')).toBe('normal')
  })

  it('starting a normal agent says nothing', () => {
    publish({ type: 'agent.started', source: 'system', payload: { employeeId: 'mika', pid: 1 } })
    expect(fx.eventsOf('breaker.state.changed')).toEqual([])
  })
})

describe('lifecycle', () => {
  it('stops watching once stopped', () => {
    breaker.stop()
    repeat('mika', 12)
    expect(breaker.levelOf('mika')).toBe('normal')
  })
})
