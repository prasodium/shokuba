import type { ShokubaEvent } from '@shared/events/schema'
import type { MissionDetail, Task } from '@shared/missions'
import type { ReviewState, ReviewVerdict, TaskReview } from '@shared/reviews'
import type { RunState, TaskVerification } from '@shared/verification'
import type { Tint } from './handoffs'

/**
 * What the state of the work looks like on the office floor. Pure: missions, tasks, and where each
 * task's checks and review stand go in; what the board, your inbox, the QA bench and the desks show
 * comes out. All of it is recorded state, so the office never shows work that is not there:
 *
 *  - the mission board holds a card for each task waiting to be picked up, and for those blocked or
 *    just accepted
 *  - your inbox holds a card for each task whose agent says it is finished and that you have not
 *    accepted or sent back yet
 *  - the bench's screens are lit while Shokuba runs a project's checks, and green or red after
 *  - a desk has a paper on it while its owner has a task in hand
 *  - someone doing an independent review sits at a reading desk while it is in progress
 */

/** Where one task's checks and review stand. */
export interface TaskWork {
  /** How the latest run of the project's checks on this task went, or null if none has run. */
  checks: RunState | null
  /** The latest independent review, or null if none was asked for. */
  review: { state: ReviewState; reviewerId: string; verdict: ReviewVerdict | null } | null
}

/**
 * Where a task's checks and review stand, from what the main process reports. A verdict on work the
 * agent has changed since is not shown: it would be a verdict on something else.
 */
export function toTaskWork(verification: TaskVerification, review: TaskReview): TaskWork {
  const latest = review.latest
  return {
    checks: verification.latest?.state ?? null,
    review: latest
      ? {
          state: latest.state,
          reviewerId: latest.reviewerId,
          verdict: review.outOfDate ? null : latest.verdict,
        }
      : null,
  }
}

/**
 * The newest event that could change where any task's checks or review stand, or 0. A run that
 * merely steps along changes nothing the office shows, so it does not count.
 */
export function latestWorkSeq(events: readonly ShokubaEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'review.changed') return event.seq
    if (event?.type === 'verification.changed' && event.payload.change !== 'step') return event.seq
  }
  return 0
}

export type BenchState = 'dark' | 'running' | 'passed' | 'failed'

/** A card on the mission board. */
export interface BoardCard {
  taskId: string
  /** Waiting to be picked up, held up, or accepted. */
  kind: 'waiting' | 'blocked' | 'done'
}

/** A card in your inbox: work that is waiting for you. */
export interface InboxCard {
  taskId: string
  /** How Shokuba's own checks went, if they ran. */
  checks: 'passed' | 'failed' | null
  /** What the independent review said, if one was handed in. */
  verdict: ReviewVerdict | null
}

export interface OfficeSignals {
  board: {
    cards: BoardCard[]
    /** The whole counts, for the name tag: the board shows only so many cards. */
    waiting: number
    blocked: number
    done: number
  }
  inbox: {
    cards: InboxCard[]
    /** The whole count: the tray shows only so many cards. */
    count: number
  }
  bench: BenchState
  /** Employees with a task handed to them and not yet handed in. */
  holding: string[]
  /** Employees in the middle of an independent review. */
  reviewing: string[]
}

export const EMPTY_SIGNALS: OfficeSignals = {
  board: { cards: [], waiting: 0, blocked: 0, done: 0 },
  inbox: { cards: [], count: 0 },
  bench: 'dark',
  holding: [],
  reviewing: [],
}

/** How many cards the board and the inbox tray have room for. */
export const BOARD_CARDS = 12
export const INBOX_CARDS = 6
/** How many accepted tasks the board keeps showing; older ones have gone to the shelf. */
export const BOARD_DONE = 4

/** Missions whose tasks belong on the floor: a draft is only a plan and a cancelled one is over. */
const ON_FLOOR: ReadonlySet<string> = new Set(['running', 'paused', 'completed'])

const time = (iso: string | null): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : 0
}

export function deriveSignals(
  missions: readonly MissionDetail[],
  work: Readonly<Record<string, TaskWork | undefined>>,
): OfficeSignals {
  const tasks: Task[] = missions
    .filter((detail) => ON_FLOOR.has(detail.mission.status))
    .flatMap((detail) => detail.tasks)

  const waiting = tasks.filter((t) => t.status === 'pending' || t.status === 'ready')
  const blocked = tasks.filter((t) => t.status === 'blocked')
  // Newest first, so the ones kept are the ones just accepted.
  const done = tasks
    .filter((t) => t.status === 'done')
    .sort((a, b) => time(b.completedAt) - time(a.completedAt))

  // Cards fill the board in this order, so if it is full the ones that need eyes stay on it.
  const cards: BoardCard[] = [
    ...blocked.map((t): BoardCard => ({ taskId: t.id, kind: 'blocked' })),
    ...waiting.map((t): BoardCard => ({ taskId: t.id, kind: 'waiting' })),
    ...done.slice(0, BOARD_DONE).map((t): BoardCard => ({ taskId: t.id, kind: 'done' })),
  ].slice(0, BOARD_CARDS)

  // Oldest first: the one that has waited longest is on top of the tray.
  const submitted = tasks
    .filter((t) => t.status === 'submitted')
    .sort((a, b) => time(a.submittedAt) - time(b.submittedAt))

  const inbox: InboxCard[] = submitted.map((t) => {
    const w = work[t.id]
    return {
      taskId: t.id,
      checks: w?.checks === 'passed' || w?.checks === 'failed' ? w.checks : null,
      verdict: w?.review?.state === 'submitted' ? w.review.verdict : null,
    }
  })

  const runs = submitted.map((t) => work[t.id]?.checks)
  const bench: BenchState = runs.includes('running')
    ? 'running'
    : runs.includes('failed')
      ? 'failed'
      : runs.includes('passed')
        ? 'passed'
        : 'dark'

  // Only work still waiting on you counts: a review of anything else is over.
  const reviewing = submitted
    .map((t) => work[t.id]?.review)
    .filter((r) => r?.state === 'in_progress')
    .map((r) => r?.reviewerId ?? '')

  const holding = tasks.filter((t) => t.status === 'in_progress').map((t) => t.assigneeId ?? '')

  return {
    board: {
      cards,
      waiting: waiting.length,
      blocked: blocked.length,
      done: done.length,
    },
    inbox: { cards: inbox.slice(0, INBOX_CARDS), count: inbox.length },
    bench,
    holding: unique(holding),
    reviewing: unique(reviewing),
  }
}

/** The ids, once each, without the empty ones. */
function unique(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => id !== ''))]
}

/**
 * How a card in the inbox is marked: by the worst thing said about it. A failed check or a review
 * asking for changes is red, a review with comments is amber, and green needs something good said
 * and nothing bad.
 */
export function inboxTint(card: InboxCard): Tint {
  if (card.verdict === 'request_changes' || card.checks === 'failed') return 'bad'
  if (card.verdict === 'comment') return 'warn'
  if (card.verdict === 'approve' || card.checks === 'passed') return 'good'
  return 'plain'
}

/** The name tags of the places that show work, with what they are showing. */
export function boardLabel(board: OfficeSignals['board']): string {
  const parts = [
    board.waiting > 0 ? `${board.waiting} waiting` : '',
    board.blocked > 0 ? `${board.blocked} blocked` : '',
    board.done > 0 ? `${board.done} done` : '',
  ].filter((part) => part !== '')
  return ['Mission board', ...parts].join(' · ')
}

export function inboxLabel(inbox: OfficeSignals['inbox']): string {
  return inbox.count > 0 ? `Your inbox · ${inbox.count} waiting` : 'Your inbox'
}

export function benchLabel(bench: BenchState): string {
  return bench === 'dark' ? 'QA bench' : `QA bench · checks ${bench}`
}
