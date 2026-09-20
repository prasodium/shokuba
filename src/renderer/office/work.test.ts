import { describe, expect, it } from 'vitest'
import type { ShokubaEvent } from '@shared/events/schema'
import type { MissionDetail, MissionStatus, Task, TaskStatus } from '@shared/missions'
import type { RunState } from '@shared/verification'
import {
  BOARD_CARDS,
  BOARD_DONE,
  EMPTY_SIGNALS,
  INBOX_CARDS,
  benchLabel,
  boardLabel,
  deriveSignals,
  inboxLabel,
  inboxTint,
  latestWorkSeq,
  toTaskWork,
  type TaskWork,
} from './work'

let counter = 0
const task = (status: TaskStatus, extra: Partial<Task> = {}): Task => {
  counter += 1
  return {
    id: `t${counter}`,
    missionId: 'm1',
    title: 'x',
    description: '',
    status,
    assigneeId: null,
    priority: 'normal',
    dependsOn: [],
    attempts: 0,
    summary: null,
    blockedReason: null,
    reviewNote: null,
    position: counter,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    startedAt: null,
    submittedAt: null,
    completedAt: null,
    ...extra,
  }
}

const mission = (tasks: Task[], status: MissionStatus = 'running'): MissionDetail => ({
  mission: {
    id: 'm1',
    title: 'Mission',
    description: '',
    status,
    priority: 'normal',
    createdBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  tasks,
})

const review = (
  state: NonNullable<TaskWork['review']>['state'],
  reviewerId = 'cy',
  verdict: NonNullable<TaskWork['review']>['verdict'] = null,
): TaskWork => ({ checks: null, review: { state, reviewerId, verdict } })

describe('deriveSignals', () => {
  it('is empty for an office with no work', () => {
    expect(deriveSignals([], {})).toEqual(EMPTY_SIGNALS)
    expect(deriveSignals([mission([])], {})).toEqual(EMPTY_SIGNALS)
  })

  describe('the mission board', () => {
    it('holds a card for each task waiting, blocked, or accepted', () => {
      const a = task('pending')
      const b = task('ready')
      const c = task('blocked')
      const d = task('done', { completedAt: '2026-01-02T00:00:00Z' })
      const { board } = deriveSignals([mission([a, b, c, d])], {})
      expect(board.cards).toEqual([
        { taskId: c.id, kind: 'blocked' },
        { taskId: a.id, kind: 'waiting' },
        { taskId: b.id, kind: 'waiting' },
        { taskId: d.id, kind: 'done' },
      ])
      expect([board.waiting, board.blocked, board.done]).toEqual([2, 1, 1])
    })

    it('has no card for work in hand, waiting for you, sent back or cancelled', () => {
      const tasks = (
        ['in_progress', 'submitted', 'changes_requested', 'cancelled'] as TaskStatus[]
      ).map((s) => task(s))
      expect(deriveSignals([mission(tasks)], {}).board.cards).toEqual([])
    })

    it('shows only the latest few accepted tasks, newest first, and counts them all', () => {
      const done = Array.from({ length: BOARD_DONE + 3 }, (_, i) =>
        task('done', { completedAt: `2026-01-0${i + 1}T00:00:00Z` }),
      )
      const { board } = deriveSignals([mission(done)], {})
      expect(board.done).toBe(done.length)
      expect(board.cards.map((c) => c.taskId)).toEqual(
        done
          .slice(-BOARD_DONE)
          .reverse()
          .map((t) => t.id),
      )
    })

    it('puts a task with no completion time last among the accepted', () => {
      const undated = task('done')
      const dated = task('done', { completedAt: '2026-01-05T00:00:00Z' })
      const { board } = deriveSignals([mission([undated, dated])], {})
      expect(board.cards.map((c) => c.taskId)).toEqual([dated.id, undated.id])
    })

    it('has room for so many cards, keeping the ones that need eyes', () => {
      const waiting = Array.from({ length: BOARD_CARDS + 3 }, () => task('ready'))
      const stuck = task('blocked')
      const { board } = deriveSignals([mission([...waiting, stuck])], {})
      expect(board.cards).toHaveLength(BOARD_CARDS)
      expect(board.cards[0]).toEqual({ taskId: stuck.id, kind: 'blocked' })
      // The counts are of everything, not just what fits.
      expect(board.waiting).toBe(BOARD_CARDS + 3)
    })
  })

  describe('which missions count', () => {
    it('leaves out drafts and cancelled missions, and keeps the rest', () => {
      const t = () => [task('ready'), task('in_progress', { assigneeId: 'ava' })]
      for (const status of ['draft', 'cancelled'] as MissionStatus[]) {
        expect(deriveSignals([mission(t(), status)], {})).toEqual(EMPTY_SIGNALS)
      }
      for (const status of ['running', 'paused', 'completed'] as MissionStatus[]) {
        const signals = deriveSignals([mission(t(), status)], {})
        expect(signals.board.waiting).toBe(1)
        expect(signals.holding).toEqual(['ava'])
      }
    })

    it('reads every mission’s tasks together', () => {
      const a = mission([task('ready')])
      const b = mission([task('ready')])
      expect(deriveSignals([a, b], {}).board.waiting).toBe(2)
    })
  })

  describe('your inbox', () => {
    it('holds a card for each submitted task, oldest first', () => {
      const late = task('submitted', { submittedAt: '2026-01-03T00:00:00Z' })
      const early = task('submitted', { submittedAt: '2026-01-01T00:00:00Z' })
      const { inbox } = deriveSignals([mission([late, early])], {})
      expect(inbox.cards.map((c) => c.taskId)).toEqual([early.id, late.id])
      expect(inbox.count).toBe(2)
    })

    it('shows how checks went, and what a handed-in review said', () => {
      const t = task('submitted')
      const work = {
        [t.id]: { checks: 'passed', review: review('submitted', 'cy', 'request_changes').review },
      } as Record<string, TaskWork>
      expect(deriveSignals([mission([t])], work).inbox.cards).toEqual([
        { taskId: t.id, checks: 'passed', verdict: 'request_changes' },
      ])
    })

    it('says nothing of checks that did not finish, or of a review that has not been handed in', () => {
      const cases: TaskWork[] = [
        { checks: 'running', review: null },
        { checks: 'error', review: null },
        { checks: 'cancelled', review: null },
        { checks: null, review: { state: 'in_progress', reviewerId: 'cy', verdict: 'approve' } },
        { checks: null, review: { state: 'queued', reviewerId: 'cy', verdict: 'approve' } },
        { checks: null, review: { state: 'cancelled', reviewerId: 'cy', verdict: 'approve' } },
        { checks: null, review: { state: 'error', reviewerId: 'cy', verdict: 'approve' } },
      ]
      for (const work of cases) {
        const t = task('submitted')
        expect(deriveSignals([mission([t])], { [t.id]: work }).inbox.cards).toEqual([
          { taskId: t.id, checks: null, verdict: null },
        ])
      }
    })

    it('shows a card even when nothing is known about the task yet', () => {
      const t = task('submitted')
      expect(deriveSignals([mission([t])], {}).inbox.cards).toEqual([
        { taskId: t.id, checks: null, verdict: null },
      ])
    })

    it('has room for so many cards, and counts them all', () => {
      const many = Array.from({ length: INBOX_CARDS + 2 }, (_, i) =>
        task('submitted', { submittedAt: `2026-01-01T00:00:0${i}Z` }),
      )
      const { inbox } = deriveSignals([mission(many)], {})
      expect(inbox.cards.map((c) => c.taskId)).toEqual(many.slice(0, INBOX_CARDS).map((t) => t.id))
      expect(inbox.count).toBe(many.length)
    })
  })

  describe('the QA bench', () => {
    const bench = (...runs: TaskWork['checks'][]) => {
      const tasks = runs.map(() => task('submitted'))
      const work: Record<string, TaskWork> = {}
      tasks.forEach((t, i) => (work[t.id] = { checks: runs[i] ?? null, review: null }))
      return deriveSignals([mission(tasks)], work).bench
    }

    it('is dark when nothing has been checked, or nothing finished well or badly', () => {
      expect(bench()).toBe('dark')
      expect(bench(null)).toBe('dark')
      expect(bench('error', 'cancelled')).toBe('dark')
    })

    it('shows how the checks went', () => {
      expect(bench('passed')).toBe('passed')
      expect(bench('failed')).toBe('failed')
    })

    it('shows failure over success, and a run in progress over both', () => {
      expect(bench('passed', 'failed')).toBe('failed')
      expect(bench('failed', 'passed')).toBe('failed')
      expect(bench('passed', 'running', 'failed')).toBe('running')
    })

    it('forgets a task’s checks once the work is no longer waiting for you', () => {
      const gone = (['done', 'in_progress', 'changes_requested'] as TaskStatus[]).map((s) =>
        task(s),
      )
      const work = Object.fromEntries(
        gone.map((t) => [t.id, { checks: 'running', review: null } as TaskWork]),
      )
      expect(deriveSignals([mission(gone)], work).bench).toBe('dark')
    })
  })

  describe('desks', () => {
    it('gives a paper to each employee with a task in hand, once', () => {
      const tasks = [
        task('in_progress', { assigneeId: 'ava' }),
        task('in_progress', { assigneeId: 'ava' }),
        task('in_progress', { assigneeId: 'bo' }),
        task('in_progress', { assigneeId: null }),
        task('submitted', { assigneeId: 'cy' }),
        task('changes_requested', { assigneeId: 'di' }),
      ]
      expect(deriveSignals([mission(tasks)], {}).holding).toEqual(['ava', 'bo'])
    })

    it('seats a reviewer while a review of work waiting for you is in progress', () => {
      const t = task('submitted')
      const work = { [t.id]: review('in_progress', 'cy') }
      expect(deriveSignals([mission([t])], work).reviewing).toEqual(['cy'])
    })

    it('does not seat one whose review is only asked for, or over', () => {
      for (const state of ['queued', 'submitted', 'cancelled', 'error'] as const) {
        const t = task('submitted')
        expect(deriveSignals([mission([t])], { [t.id]: review(state) }).reviewing).toEqual([])
      }
    })

    it('does not seat a reviewer once the work has left your inbox', () => {
      for (const status of ['done', 'changes_requested', 'in_progress'] as TaskStatus[]) {
        const t = task(status)
        expect(deriveSignals([mission([t])], { [t.id]: review('in_progress') }).reviewing).toEqual(
          [],
        )
      }
    })

    it('seats each reviewer once, however many reviews they are doing', () => {
      const a = task('submitted')
      const b = task('submitted')
      const work = { [a.id]: review('in_progress', 'cy'), [b.id]: review('in_progress', 'cy') }
      expect(deriveSignals([mission([a, b])], work).reviewing).toEqual(['cy'])
    })
  })
})

describe('toTaskWork', () => {
  const run = (state: RunState) =>
    ({ latest: { state } }) as unknown as Parameters<typeof toTaskWork>[0]
  const noRun = { latest: null } as unknown as Parameters<typeof toTaskWork>[0]
  const reviewOf = (latest: object | null, outOfDate = false) =>
    ({ latest, outOfDate }) as unknown as Parameters<typeof toTaskWork>[1]
  const handedIn = { state: 'submitted', reviewerId: 'cy', verdict: 'approve' }

  it('takes the state of the latest run, and nothing if none has run', () => {
    expect(toTaskWork(run('failed'), reviewOf(null)).checks).toBe('failed')
    expect(toTaskWork(noRun, reviewOf(null)).checks).toBeNull()
  })

  it('takes the latest review’s state, reviewer and verdict', () => {
    expect(toTaskWork(noRun, reviewOf(handedIn)).review).toEqual({
      state: 'submitted',
      reviewerId: 'cy',
      verdict: 'approve',
    })
    expect(toTaskWork(noRun, reviewOf(null)).review).toBeNull()
  })

  it('drops the verdict, but not the review, when the work has changed since', () => {
    expect(toTaskWork(noRun, reviewOf(handedIn, true)).review).toEqual({
      state: 'submitted',
      reviewerId: 'cy',
      verdict: null,
    })
  })
})

describe('latestWorkSeq', () => {
  let n = 0
  const ev = (type: string, payload: Record<string, unknown>): ShokubaEvent =>
    ({ seq: (n += 1), id: `e${n}`, ts: 't', source: 'system', type, payload }) as ShokubaEvent
  const verification = (change: string) => ev('verification.changed', { taskId: 't', change })

  it('is the newest review, or run that started or ended', () => {
    for (const change of ['started', 'finished', 'cancelled', 'error']) {
      const events = [ev('agent.ready', {}), verification(change), ev('agent.ready', {})]
      expect(latestWorkSeq(events)).toBe(events[1]?.seq)
    }
    const review = [ev('review.changed', { taskId: 't', change: 'started' }), ev('agent.ready', {})]
    expect(latestWorkSeq(review)).toBe(review[0]?.seq)
  })

  it('does not count a run merely stepping along', () => {
    const events = [verification('started'), verification('step'), verification('step')]
    expect(latestWorkSeq(events)).toBe(events[0]?.seq)
    expect(latestWorkSeq([verification('step')])).toBe(0)
  })

  it('is 0 when there is nothing', () => {
    expect(latestWorkSeq([])).toBe(0)
    expect(latestWorkSeq([ev('agent.ready', {})])).toBe(0)
  })
})

describe('inboxTint', () => {
  const card = (
    checks: 'passed' | 'failed' | null,
    verdict: 'approve' | 'request_changes' | 'comment' | null,
  ) => inboxTint({ taskId: 't', checks, verdict })

  it('is plain when nothing has been said', () => {
    expect(card(null, null)).toBe('plain')
  })

  it('is green for good news alone, from either', () => {
    expect(card('passed', null)).toBe('good')
    expect(card(null, 'approve')).toBe('good')
    expect(card('passed', 'approve')).toBe('good')
  })

  it('is amber for comments, unless something worse was said', () => {
    expect(card(null, 'comment')).toBe('warn')
    expect(card('passed', 'comment')).toBe('warn')
    expect(card('failed', 'comment')).toBe('bad')
  })

  it('is red when either says it is not right, whatever else was said', () => {
    expect(card('failed', null)).toBe('bad')
    expect(card(null, 'request_changes')).toBe('bad')
    expect(card('failed', 'approve')).toBe('bad')
    expect(card('passed', 'request_changes')).toBe('bad')
  })
})

describe('the name tags', () => {
  it('say what the board holds, leaving out what it does not', () => {
    const board = (waiting: number, blocked: number, done: number) => ({
      cards: [],
      waiting,
      blocked,
      done,
    })
    expect(boardLabel(board(0, 0, 0))).toBe('Mission board')
    expect(boardLabel(board(2, 0, 0))).toBe('Mission board · 2 waiting')
    expect(boardLabel(board(0, 1, 5))).toBe('Mission board · 1 blocked · 5 done')
    expect(boardLabel(board(3, 1, 7))).toBe('Mission board · 3 waiting · 1 blocked · 7 done')
  })

  it('say how much waits in your inbox', () => {
    expect(inboxLabel({ cards: [], count: 0 })).toBe('Your inbox')
    expect(inboxLabel({ cards: [], count: 4 })).toBe('Your inbox · 4 waiting')
  })

  it('say when the checks are running, or how they went, and only then', () => {
    expect(benchLabel('dark')).toBe('QA bench')
    expect(benchLabel('running')).toBe('QA bench · checks running')
    expect(benchLabel('passed')).toBe('QA bench · checks passed')
    expect(benchLabel('failed')).toBe('QA bench · checks failed')
  })
})
