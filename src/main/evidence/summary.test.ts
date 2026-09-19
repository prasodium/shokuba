import { describe, expect, it } from 'vitest'
import type { EventSource, ShokubaEvent } from '@shared/events/schema'
import {
  checksHeadline,
  outcomeOf,
  reviewsHeadline,
  timelineOf,
  timelineText,
  TIMELINE_LIMIT,
} from './summary'
import type { CheckRunRecord, CheckStepRecord, ReviewRecord } from './types'

const step = (patch: Partial<CheckStepRecord>): CheckStepRecord => ({
  position: 0,
  kind: 'check',
  name: 'Test',
  command: 'npm test',
  state: 'passed',
  exitCode: 0,
  durationMs: 10,
  outputTruncated: false,
  logFile: null,
  ...patch,
})
const run = (patch: Partial<CheckRunRecord>): CheckRunRecord => ({
  id: 'r1',
  commit: 'a'.repeat(40),
  onFinalCommit: true,
  trigger: 'auto',
  state: 'passed',
  startedAt: 't',
  finishedAt: 't',
  note: null,
  steps: [step({})],
  ...patch,
})
const review = (patch: Partial<ReviewRecord>): ReviewRecord => ({
  id: 'v1',
  reviewer: { id: 'sora', name: 'Sora' },
  commit: 'a'.repeat(40),
  onFinalCommit: true,
  state: 'submitted',
  verdict: 'approve',
  summary: 'Fine.',
  findings: [],
  requestedBy: 'manual',
  createdAt: 't',
  submittedAt: 't',
  note: null,
  ...patch,
})

const event = (
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  source: EventSource = 'system',
): ShokubaEvent =>
  ({ seq, id: `e${seq}`, ts: `2026-01-01T00:00:0${seq % 10}.000Z`, source, type, payload }) as never

describe('checksHeadline', () => {
  it('says so when no checks were run', () => {
    expect(checksHeadline([])).toBe('No checks were run on this work.')
  })

  it('counts the checks and says whether they ran on the commit the work ended at', () => {
    const two = [step({}), step({ name: 'Lint' })]
    expect(checksHeadline([run({ steps: two })])).toBe('All 2 checks passed on the final commit.')
    expect(checksHeadline([run({ steps: [step({})] })])).toBe(
      'The one check passed on the final commit.',
    )
    expect(checksHeadline([run({ steps: two, onFinalCommit: false })])).toBe(
      'All 2 checks passed on an earlier commit than the final one.',
    )
  })

  it('says so when it cannot tell which commit the work ended at', () => {
    expect(checksHeadline([run({ onFinalCommit: null })])).toBe(
      'The one check passed on a commit that could not be compared with the final one.',
    )
    expect(reviewsHeadline([review({ onFinalCommit: null })])).toContain(
      'on a commit that could not be compared with the final one',
    )
  })

  it('does not count setup steps as checks', () => {
    const steps = [step({ kind: 'setup', name: 'Install' }), step({}), step({ name: 'Lint' })]
    expect(checksHeadline([run({ steps })])).toBe('All 2 checks passed on the final commit.')
  })

  it('counts the ones that did not pass, whatever went wrong with them', () => {
    const steps = [
      step({}),
      step({ name: 'Lint', state: 'failed', exitCode: 1 }),
      step({ name: 'Build', state: 'timeout', exitCode: null }),
    ]
    expect(checksHeadline([run({ state: 'failed', steps })])).toBe(
      '2 of 3 checks did not pass on the final commit.',
    )
    expect(checksHeadline([run({ state: 'failed', steps: [step({ state: 'failed' })] })])).toBe(
      '1 of 1 check did not pass on the final commit.',
    )
  })

  it('says a failed setup is why the checks did not run', () => {
    const steps = [step({ kind: 'setup', state: 'failed' }), step({ state: 'skipped' })]
    expect(checksHeadline([run({ state: 'failed', steps })])).toBe(
      'A setup step failed, so the checks did not run on the final commit.',
    )
    // Checks that ran and failed are still counted as failed, even if a setup step passed.
    expect(
      checksHeadline([
        run({ state: 'failed', steps: [step({ kind: 'setup' }), step({ state: 'failed' })] }),
      ]),
    ).toBe('1 of 1 check did not pass on the final commit.')
    expect(
      checksHeadline([run({ state: 'failed', steps: [step({ kind: 'setup', state: 'failed' })] })]),
    ).toBe('A setup step failed, so the checks did not run on the final commit.')
  })

  it('judges by the newest run, and reports one that did not finish', () => {
    const older = run({ id: 'old', state: 'failed', steps: [step({ state: 'failed' })] })
    expect(checksHeadline([older, run({ id: 'new' })])).toBe(
      'The one check passed on the final commit.',
    )
    expect(checksHeadline([run({ state: 'running' })])).toBe(
      'A run of the checks was still under way.',
    )
    expect(checksHeadline([run({ state: 'cancelled' })])).toContain('cancelled')
    expect(checksHeadline([run({ state: 'error', note: 'the folder is gone' })])).toBe(
      'The checks could not be run; the run below says why.',
    )
  })

  it('never repeats what a step, a command or a note said', () => {
    const hostile = '[x](https://evil.invalid) <b>'
    const text = checksHeadline([
      run({
        state: 'failed',
        note: hostile,
        steps: [step({ name: hostile, command: hostile, state: 'failed' })],
      }),
    ])
    expect(text).not.toContain('evil')
  })
})

describe('reviewsHeadline', () => {
  it('says so when there was no review', () => {
    expect(reviewsHeadline([])).toBe('No independent review was made.')
  })

  it('says what the reviewer concluded, how much they found, and which commit they read', () => {
    expect(reviewsHeadline([review({})])).toBe(
      'The reviewer approved the work on the final commit, with no findings.',
    )
    const found = [
      { severity: 'major' as const, file: null, line: null, note: 'a' },
      { severity: 'nit' as const, file: null, line: null, note: 'b' },
    ]
    expect(reviewsHeadline([review({ verdict: 'request_changes', findings: found })])).toBe(
      'The reviewer asked for changes on the final commit, with 2 findings.',
    )
    expect(reviewsHeadline([review({ verdict: 'comment', onFinalCommit: false })])).toBe(
      'The reviewer left comments on an earlier commit than the final one, with no findings.',
    )
  })

  it('judges by the newest review and says how many there were', () => {
    const first = review({ id: 'one', verdict: 'request_changes' })
    expect(reviewsHeadline([first, review({ id: 'two' })])).toBe(
      'The reviewer approved the work on the final commit, with no findings. There were 2 reviews in all.',
    )
  })

  it('says where a review that did not finish stands', () => {
    expect(reviewsHeadline([review({ state: 'queued', verdict: null })])).toContain(
      'had not started',
    )
    expect(reviewsHeadline([review({ state: 'in_progress', verdict: null })])).toContain(
      'under way',
    )
    expect(reviewsHeadline([review({ state: 'cancelled', verdict: null })])).toContain('dropped')
    expect(reviewsHeadline([review({ state: 'error', verdict: null })])).toContain(
      'could not be finished',
    )
  })

  it('never repeats what the reviewer or a note said', () => {
    const text = reviewsHeadline([
      review({
        summary: '[x](https://evil.invalid)',
        note: '<script>',
        reviewer: { id: 's', name: '<b>Sora</b>' },
        findings: [
          { severity: 'nit', file: null, line: null, note: '![](https://evil.invalid/x.png)' },
        ],
      }),
    ])
    expect(text).not.toMatch(/evil|<|Sora/)
  })
})

describe('outcomeOf', () => {
  const change = (seq: number, to: string, source: EventSource = 'user') =>
    event(seq, 'task.status.changed', { taskId: 't', missionId: 'm', from: 'x', to }, source)

  it('says who accepted the work and when, and how often it was sent back', () => {
    const events = [
      change(1, 'in_progress', 'system'),
      change(2, 'submitted', 'reported'),
      change(3, 'changes_requested'),
      change(4, 'in_progress', 'system'),
      change(5, 'submitted', 'reported'),
      change(6, 'done'),
    ]
    expect(outcomeOf(events, 'done', 'later')).toEqual({
      accepted: true,
      acceptedAt: events[5]?.ts,
      acceptedBy: 'person',
      sentBack: 1,
    })
  })

  it('does not call it accepted by a person unless the log says it was a person', () => {
    expect(outcomeOf([change(1, 'done', 'reported')], 'done', null).acceptedBy).toBe('other')
    expect(outcomeOf([change(1, 'done', 'system')], 'done', null).acceptedBy).toBe('other')
  })

  it('is not accepted while it is anything but done, even if it once was', () => {
    expect(outcomeOf([change(1, 'submitted', 'reported')], 'submitted', null)).toEqual({
      accepted: false,
      acceptedAt: null,
      acceptedBy: null,
      sentBack: 0,
    })
    expect(outcomeOf([change(1, 'done')], 'cancelled', null).accepted).toBe(false)
  })

  it('says when it is done but the log cannot say who did it', () => {
    expect(outcomeOf([], 'done', 'the-time')).toEqual({
      accepted: true,
      acceptedAt: 'the-time',
      acceptedBy: null,
      sentBack: 0,
    })
  })
})

describe('the timeline', () => {
  const names = (id: string): string => (id === 'ren' ? 'Ren' : id === 'sora' ? 'Sora' : id)

  it('puts each kind of event in a line', () => {
    const lines = (type: string, payload: Record<string, unknown>) =>
      timelineText(event(1, type, payload), names)
    expect(lines('task.created', {})).toBe('Task created')
    expect(lines('task.assigned', { employeeId: 'ren' })).toBe('Assigned to Ren')
    expect(lines('task.assigned', { employeeId: null })).toBe('Assignment removed')
    expect(lines('task.dispatched', { employeeId: 'ren', attempt: 2 })).toBe(
      'Handed to Ren (attempt 2)',
    )
    expect(lines('task.status.changed', { from: 'submitted', to: 'done' })).toBe(
      'Status submitted → done',
    )
    expect(
      lines('task.status.changed', { from: 'submitted', to: 'blocked', reason: 'no access' }),
    ).toBe('Status submitted → blocked: no access')
    expect(lines('workspace.changed', { change: 'created' })).toBe(
      'Working folder and branch created',
    )
    expect(lines('workspace.changed', { change: 'committed', commit: 'abcdef0123456789' })).toBe(
      'Work saved as commit abcdef01',
    )
    expect(lines('workspace.changed', { change: 'conflict', files: ['a.txt', 'b.txt'] })).toBe(
      'Merge conflict in a.txt, b.txt',
    )
    expect(lines('workspace.changed', { change: 'merged' })).toBe(
      'Work merged into the mission branch',
    )
    expect(lines('verification.changed', { change: 'started' })).toBe('Checks started')
    expect(lines('verification.changed', { change: 'finished', state: 'failed' })).toBe(
      'Checks finished: failed',
    )
    expect(lines('review.changed', { change: 'requested', reviewerId: 'sora' })).toBe(
      'Review asked of Sora',
    )
    expect(
      lines('review.changed', {
        change: 'submitted',
        reviewerId: 'sora',
        verdict: 'request_changes',
      }),
    ).toBe('Sora handed in a review (request changes)')
  })

  it('leaves out a step of a run, and events about anything else', () => {
    expect(timelineText(event(1, 'verification.changed', { change: 'step' }), names)).toBeNull()
    expect(timelineText(event(1, 'agent.state.changed', {}), names)).toBeNull()
    expect(timelineText(event(1, 'message.sent', {}), names)).toBeNull()
  })

  it('does not carry a path that an event’s reason names', () => {
    const { entries } = timelineOf(
      [
        event(1, 'workspace.changed', {
          change: 'unavailable',
          reason: 'no Git at /usr/local/bin/git',
        }),
      ],
      names,
    )
    expect(entries[0]?.text).toBe('Ran without its own folder: no Git at [path]')
  })

  it('keeps each entry’s time and where the log says it came from', () => {
    const { entries, truncated } = timelineOf(
      [
        event(1, 'task.created', {}, 'user'),
        event(2, 'agent.state.changed', {}, 'reported'),
        event(3, 'task.status.changed', { from: 'submitted', to: 'done' }, 'user'),
      ],
      names,
    )
    expect(truncated).toBe(false)
    expect(entries.map((e) => [e.seq, e.source, e.text])).toEqual([
      [1, 'user', 'Task created'],
      [3, 'user', 'Status submitted → done'],
    ])
  })

  it('keeps the newest entries when there are too many, and says so', () => {
    const many = Array.from({ length: TIMELINE_LIMIT + 5 }, (_, i) =>
      event(i + 1, 'task.created', {}),
    )
    const { entries, truncated } = timelineOf(many, names)
    expect(truncated).toBe(true)
    expect(entries).toHaveLength(TIMELINE_LIMIT)
    expect(entries[0]?.seq).toBe(6)
    expect(entries.at(-1)?.seq).toBe(TIMELINE_LIMIT + 5)
  })
})
