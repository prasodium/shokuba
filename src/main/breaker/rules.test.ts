import { describe, expect, it } from 'vitest'
import { AgentMeter, THRESHOLDS, callKey, isEditTool, levelFor } from './rules'

const MIN = 60_000

describe('levelFor', () => {
  const ladder = { warning: 5, constrain: 8, pause: 12 }

  it('steps up at each threshold, and only there', () => {
    expect([4, 5, 7, 8, 11, 12, 99].map((n) => levelFor(n, ladder))).toEqual([
      'normal',
      'warning',
      'warning',
      'constrain',
      'constrain',
      'pause',
      'pause',
    ])
  })

  it('never pauses on a ladder that has no pause step', () => {
    expect(levelFor(1_000_000, { warning: 1, constrain: 2 })).toBe('constrain')
  })

  it('has the agreed defaults', () => {
    expect(THRESHOLDS.repeatedCalls).toEqual({ warning: 5, constrain: 8, pause: 12 })
    expect(THRESHOLDS.failedCalls).toEqual({ warning: 6, constrain: 10, pause: 15 })
    expect(THRESHOLDS.fileChanges).toEqual({ warning: 40, constrain: 80, pause: 150 })
    expect(THRESHOLDS.failedTurns).toMatchObject({ warning: 2, constrain: 3, pause: 5 })
    expect('pause' in THRESHOLDS.longTurn).toBe(false)
    expect('pause' in THRESHOLDS.haltedConversations).toBe(false)
  })
})

describe('repeated calls', () => {
  const repeat = (meter: AgentMeter, times: number, summary = 'Run npm test', tool = 'Bash') => {
    for (let i = 0; i < times; i++) meter.toolStarted(tool, summary)
  }

  it('is quiet below the first threshold', () => {
    const meter = new AgentMeter()
    repeat(meter, 4)
    expect(meter.assess(0)).toBeNull()
  })

  it('warns, constrains and pauses as the streak grows, naming the call', () => {
    const meter = new AgentMeter()
    repeat(meter, 5)
    expect(meter.assess(0)).toMatchObject({
      rule: 'repeated-call',
      level: 'warning',
      callKey: callKey('Bash', 'Run npm test'),
    })
    expect(meter.assess(0)?.detail).toBe('the same call (Run npm test) 5 times in a row')
    repeat(meter, 3)
    expect(meter.assess(0)?.level).toBe('constrain')
    repeat(meter, 4)
    expect(meter.assess(0)?.level).toBe('pause')
  })

  it('starts counting again as soon as the agent does something different', () => {
    const meter = new AgentMeter()
    repeat(meter, 7)
    meter.toolStarted('Edit', 'Edit src/a.ts')
    expect(meter.assess(0)).toBeNull()
    repeat(meter, 4)
    expect(meter.assess(0)).toBeNull()
  })

  it('treats a different summary, or a different tool, as a different call', () => {
    const meter = new AgentMeter()
    repeat(meter, 4)
    meter.toolStarted('Bash', 'Run npm run lint')
    repeat(meter, 4, 'Run npm test', 'PowerShell')
    expect(meter.assess(0)).toBeNull()
  })
})

describe('failed calls', () => {
  it('counts failures in a row, and a success clears the run', () => {
    const meter = new AgentMeter()
    for (let i = 0; i < 6; i++) meter.toolFinished(false)
    expect(meter.assess(0)).toMatchObject({ rule: 'failed-calls', level: 'warning' })
    meter.toolFinished(true)
    expect(meter.assess(0)).toBeNull()
    for (let i = 0; i < 10; i++) meter.toolFinished(false)
    expect(meter.assess(0)?.level).toBe('constrain')
    for (let i = 0; i < 5; i++) meter.toolFinished(false)
    expect(meter.assess(0)?.level).toBe('pause')
  })
})

describe('failed turns', () => {
  it('counts only the last ten minutes', () => {
    const meter = new AgentMeter()
    meter.turnFailed(0)
    meter.turnFailed(1 * MIN)
    expect(meter.assess(2 * MIN)).toMatchObject({ rule: 'failed-turns', level: 'warning' })
    expect(meter.assess(9 * MIN)?.level).toBe('warning')
    // The first has aged out, leaving one.
    expect(meter.assess(10.5 * MIN)).toBeNull()
  })

  it('constrains at three and pauses at five', () => {
    const meter = new AgentMeter()
    for (let i = 0; i < 3; i++) meter.turnFailed(i)
    expect(meter.assess(10)?.level).toBe('constrain')
    for (let i = 0; i < 2; i++) meter.turnFailed(10 + i)
    expect(meter.assess(20)?.level).toBe('pause')
  })
})

describe('file changes', () => {
  const edit = (meter: AgentMeter, count: number, from = 0) => {
    for (let i = 0; i < count; i++) meter.toolStarted('Write', `Edit src/file-${from + i}.ts`)
  }

  it('counts different files, not edits', () => {
    const meter = new AgentMeter()
    for (let i = 0; i < 100; i++) meter.toolStarted('Edit', 'Edit src/same.ts')
    // (that is a repeated call, but only one file)
    expect(meter.assess(0)?.rule).toBe('repeated-call')
    const other = new AgentMeter()
    edit(other, 39)
    expect(other.assess(0)).toBeNull()
  })

  it('warns at 40, constrains at 80, pauses at 150', () => {
    const meter = new AgentMeter()
    edit(meter, 40)
    expect(meter.assess(0)).toMatchObject({ rule: 'file-changes', level: 'warning' })
    edit(meter, 40, 40)
    expect(meter.assess(0)?.level).toBe('constrain')
    edit(meter, 70, 80)
    expect(meter.assess(0)?.level).toBe('pause')
  })

  it('starts again when a new task is handed over', () => {
    const meter = new AgentMeter()
    edit(meter, 45)
    expect(meter.assess(0)?.level).toBe('warning')
    meter.taskStarted()
    expect(meter.assess(0)).toBeNull()
  })

  it('does not count reads or shell commands as edits', () => {
    const meter = new AgentMeter()
    for (let i = 0; i < 60; i++) {
      meter.toolStarted('Read', `Read src/file-${i}.ts`)
      meter.toolStarted('Bash', `Run cat file-${i}`)
    }
    expect(meter.assess(0)).toBeNull()
  })

  it('knows which tools edit', () => {
    expect(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].every(isEditTool)).toBe(true)
    expect(['Read', 'Bash', 'Grep'].some(isEditTool)).toBe(false)
  })
})

describe('a long turn', () => {
  it('warns at 30 minutes and constrains at 90, but never pauses by itself', () => {
    const meter = new AgentMeter()
    meter.turnStarted(0)
    expect(meter.assess(29 * MIN)).toBeNull()
    expect(meter.assess(30 * MIN)).toMatchObject({ rule: 'long-turn', level: 'warning' })
    expect(meter.assess(30 * MIN)?.detail).toBe('one turn has been running for 30 minutes')
    expect(meter.assess(90 * MIN)?.level).toBe('constrain')
    expect(meter.assess(10_000 * MIN)?.level).toBe('constrain')
  })

  it('stops counting when the turn ends', () => {
    const meter = new AgentMeter()
    meter.turnStarted(0)
    meter.turnFinished()
    expect(meter.assess(500 * MIN)).toBeNull()
  })
})

describe('halted conversations', () => {
  it('warns on the first and constrains on the second within half an hour', () => {
    const meter = new AgentMeter()
    meter.conversationHalted(0)
    expect(meter.assess(1 * MIN)).toMatchObject({ rule: 'halted-conversations', level: 'warning' })
    meter.conversationHalted(5 * MIN)
    expect(meter.assess(6 * MIN)?.level).toBe('constrain')
    expect(meter.assess(40 * MIN)).toBeNull()
  })
})

describe('the most serious finding wins', () => {
  it('reports the highest level when several rules are tripped', () => {
    const meter = new AgentMeter()
    for (let i = 0; i < 5; i++) meter.toolStarted('Bash', 'Run x') // warning
    for (let i = 0; i < 10; i++) meter.toolFinished(false) // constrain
    expect(meter.assess(0)).toMatchObject({ rule: 'failed-calls', level: 'constrain' })
  })

  it('forgets everything on reset', () => {
    const meter = new AgentMeter()
    for (let i = 0; i < 12; i++) meter.toolStarted('Bash', 'Run x')
    meter.turnStarted(0)
    meter.reset()
    expect(meter.assess(1000 * MIN)).toBeNull()
  })
})
