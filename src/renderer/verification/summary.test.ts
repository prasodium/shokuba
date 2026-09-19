import { describe, expect, it } from 'vitest'
import type { CheckResult, CheckRun, TaskVerification } from '@shared/verification'
import {
  acceptConcern,
  acceptQuestion,
  canRunAgain,
  durationText,
  runHeadline,
  runTone,
} from './summary'

const result = (patch: Partial<CheckResult>): CheckResult => ({
  position: 0,
  kind: 'check',
  name: 'Test',
  command: 'npm test',
  state: 'passed',
  exitCode: 0,
  durationMs: 100,
  output: '',
  truncated: false,
  ...patch,
})
const run = (patch: Partial<CheckRun>): CheckRun => ({
  id: 'r1',
  taskId: 't1',
  commit: 'a'.repeat(40),
  trigger: 'auto',
  state: 'passed',
  startedAt: 't',
  finishedAt: 't',
  note: null,
  results: [],
  ...patch,
})
const verification = (latest: CheckRun | null, configured = true): TaskVerification => ({
  repoRoot: '/p',
  repoName: 'p',
  configured,
  reason: null,
  latest,
})

describe('durationText', () => {
  it('says how long a step took', () => {
    expect(durationText(40)).toBe('<1s')
    expect(durationText(1_400)).toBe('1s')
    expect(durationText(59_000)).toBe('59s')
    expect(durationText(61_000)).toBe('1m 01s')
    expect(durationText(605_000)).toBe('10m 05s')
  })
})

describe('runHeadline', () => {
  it('counts only the checks, not the setup that got them ready', () => {
    const passed = run({
      results: [
        result({ kind: 'setup', name: 'Install' }),
        result({ name: 'Test' }),
        result({ name: 'Lint' }),
      ],
    })
    expect(runHeadline(passed)).toBe('Checks passed (2 of 2)')
  })

  it('names what did not pass', () => {
    const failed = run({
      state: 'failed',
      results: [
        result({ name: 'Lint' }),
        result({ name: 'Test', state: 'failed', exitCode: 1 }),
        result({ name: 'Build', state: 'timeout', exitCode: null }),
      ],
    })
    expect(runHeadline(failed)).toBe('2 of 3 checks did not pass: Test, Build')
  })

  it('says a failed setup is why the checks did not run', () => {
    const setup = run({
      state: 'failed',
      note: 'A setup step failed, so the checks could not run.',
    })
    expect(runHeadline(setup)).toBe('A setup step failed, so the checks could not run.')
  })

  it('says what happened when a run never got going, was cancelled, or is under way', () => {
    expect(runHeadline(run({ state: 'error', note: 'The task’s working folder is gone.' }))).toBe(
      'The task’s working folder is gone.',
    )
    expect(runHeadline(run({ state: 'error', note: null }))).toBe('The checks could not be run')
    expect(runHeadline(run({ state: 'cancelled' }))).toBe(
      'Checks were cancelled because the work changed',
    )
    expect(runHeadline(run({ state: 'running' }))).toBe('Checks are running…')
  })
})

describe('runTone', () => {
  it('is good for a pass, bad for a failure or an error, and neutral otherwise', () => {
    expect(runTone(run({ state: 'passed' }))).toBe('good')
    expect(runTone(run({ state: 'failed' }))).toBe('bad')
    expect(runTone(run({ state: 'error' }))).toBe('bad')
    expect(runTone(run({ state: 'running' }))).toBe('neutral')
    expect(runTone(run({ state: 'cancelled' }))).toBe('neutral')
  })
})

describe('acceptConcern', () => {
  it('says nothing when the checks passed, are running, or have not been run', () => {
    expect(acceptConcern(verification(run({ state: 'passed' })))).toBeNull()
    expect(acceptConcern(verification(run({ state: 'running' })))).toBeNull()
    expect(acceptConcern(verification(run({ state: 'cancelled' })))).toBeNull()
    expect(acceptConcern(verification(null))).toBeNull()
  })

  it('names what did not pass', () => {
    const concern = acceptConcern(
      verification(
        run({ state: 'failed', results: [result({ name: 'Test', state: 'failed', exitCode: 1 })] }),
      ),
    )
    expect(concern).toBe('1 of 1 checks did not pass: Test.')
  })

  it('says the work has not been checked when the checks could not run', () => {
    const concern = acceptConcern(
      verification(run({ state: 'error', note: 'The task’s working folder is gone.' })),
    )
    expect(concern).toContain('so this work has not been checked')
  })
})

describe('acceptQuestion', () => {
  it('asks nothing when nothing gave pause', () => {
    expect(acceptQuestion([])).toBeNull()
    expect(acceptQuestion([null, null])).toBeNull()
  })

  it('asks once, whatever the number of concerns, and only ever asks', () => {
    expect(acceptQuestion(['Two checks failed.'])).toBe(
      'Two checks failed.\n\nAccept the work anyway?',
    )
    expect(acceptQuestion(['Two checks failed.', null, 'Sora asked for changes.'])).toBe(
      'Two checks failed.\n\nSora asked for changes.\n\nAccept the work anyway?',
    )
  })
})

describe('canRunAgain', () => {
  it('needs checks to be set up, and the agent to have stopped', () => {
    expect(canRunAgain(verification(null), 'submitted')).toBe(true)
    expect(canRunAgain(verification(null), 'blocked')).toBe(true)
    expect(canRunAgain(verification(null), 'in_progress')).toBe(false)
    expect(canRunAgain(verification(null), 'done')).toBe(false)
    expect(canRunAgain(verification(null, false), 'submitted')).toBe(false)
  })

  it('is not offered while a run is under way', () => {
    expect(canRunAgain(verification(run({ state: 'running' })), 'submitted')).toBe(false)
  })
})
