import type { EventSource, ShokubaEvent } from '@shared/events/schema'
import type { ReviewVerdict } from '@shared/reviews'
import { scrubPaths } from './markdown'
import type { CheckRunRecord, EvidencePack, ReviewRecord, TimelineEntry } from './types'

/**
 * The facts of a pack put into plain sentences. Nothing here contains text that someone else
 * wrote (a step's name, a reviewer's words, a note), only counts and states, so a sentence can be
 * written into a report as it is. Names and notes are shown separately, as inert code spans.
 */

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** Where the checked or reviewed commit stands against the one the work ended at. */
const placeOf = (onFinalCommit: boolean | null): string =>
  onFinalCommit === true
    ? 'on the final commit'
    : onFinalCommit === false
      ? 'on an earlier commit than the final one'
      : 'on a commit that could not be compared with the final one'

/** How the log recorded where an event came from, for a person reading the timeline. */
export const SOURCE_LABELS: Record<EventSource, string> = {
  user: 'a person',
  system: 'Shokuba',
  reported: 'the agent (reported)',
  inferred: 'Shokuba (inferred)',
  simulated: 'a demo agent',
}

export function checksHeadline(runs: readonly CheckRunRecord[]): string {
  const last = runs.at(-1)
  if (!last) return 'No checks were run on this work.'
  const where = placeOf(last.onFinalCommit)
  const judged = last.steps.filter((step) => step.kind === 'check')
  switch (last.state) {
    case 'running':
      return 'A run of the checks was still under way.'
    case 'cancelled':
      return 'The last run of the checks was cancelled because the work changed.'
    case 'error':
      return 'The checks could not be run; the run below says why.'
    case 'passed':
      return `${judged.length === 1 ? 'The one check' : `All ${judged.length} checks`} passed ${where}.`
    case 'failed': {
      const bad = judged.filter((step) => step.state !== 'passed').length
      // A setup step that failed leaves the checks unrun, which is not the same as failing them.
      const setupFailed = last.steps.some(
        (step) => step.kind === 'setup' && step.state !== 'passed',
      )
      if (bad === 0 || (setupFailed && judged.every((step) => step.state === 'skipped'))) {
        return `A setup step failed, so the checks did not run ${where}.`
      }
      return `${bad} of ${plural(judged.length, 'check')} did not pass ${where}.`
    }
  }
}

const VERDICT_PHRASES: Record<ReviewVerdict, string> = {
  approve: 'approved the work',
  request_changes: 'asked for changes',
  comment: 'left comments',
}

export function reviewsHeadline(reviews: readonly ReviewRecord[]): string {
  const last = reviews.at(-1)
  if (!last) return 'No independent review was made.'
  const where = placeOf(last.onFinalCommit)
  const also = reviews.length > 1 ? ` There were ${reviews.length} reviews in all.` : ''
  switch (last.state) {
    case 'queued':
      return `A review was asked for but had not started.${also}`
    case 'in_progress':
      return `A review was under way.${also}`
    case 'cancelled':
      return `The last review was dropped because the work changed.${also}`
    case 'error':
      return `The last review could not be finished.${also}`
    case 'submitted': {
      const phrase = last.verdict ? VERDICT_PHRASES[last.verdict] : 'handed in a review'
      const found =
        last.findings.length === 0 ? 'no findings' : plural(last.findings.length, 'finding')
      return `The reviewer ${phrase} ${where}, with ${found}.${also}`
    }
  }
}

/** Who accepted the work, when, and how often it was sent back, from the task's own events. */
export function outcomeOf(
  events: readonly ShokubaEvent[],
  status: string,
  completedAt: string | null,
): EvidencePack['outcome'] {
  let sentBack = 0
  let accepted: { ts: string; source: EventSource } | null = null
  for (const event of events) {
    if (event.type !== 'task.status.changed') continue
    if (event.payload.to === 'changes_requested') sentBack += 1
    if (event.payload.to === 'done') accepted = { ts: event.ts, source: event.source }
  }
  if (status !== 'done') return { accepted: false, acceptedAt: null, acceptedBy: null, sentBack }
  return {
    accepted: true,
    acceptedAt: accepted?.ts ?? completedAt,
    acceptedBy: accepted ? (accepted.source === 'user' ? 'person' : 'other') : null,
    sentBack,
  }
}

const CHANGES: Record<string, string> = {
  created: 'Working folder and branch created',
  merged: 'Work merged into the mission branch',
  removed: 'Working folder removed (the branch stays)',
  unavailable: 'Ran without its own folder',
}

/** One line for an event in the task's timeline, or null for one that is not worth a line. */
export function timelineText(
  event: ShokubaEvent,
  nameOf: (employeeId: string) => string,
): string | null {
  switch (event.type) {
    case 'task.created':
      return 'Task created'
    case 'task.assigned':
      return event.payload.employeeId
        ? `Assigned to ${nameOf(event.payload.employeeId)}`
        : 'Assignment removed'
    case 'task.dispatched':
      return `Handed to ${nameOf(event.payload.employeeId)} (attempt ${event.payload.attempt})`
    case 'task.status.changed': {
      const { from, to, reason } = event.payload
      return `Status ${from} → ${to}${reason ? `: ${reason}` : ''}`
    }
    case 'workspace.changed': {
      const { change, commit, files, reason } = event.payload
      if (change === 'committed') return `Work saved as commit ${(commit ?? '').slice(0, 8)}`.trim()
      if (change === 'conflict') {
        return `Merge conflict in ${files && files.length > 0 ? files.join(', ') : 'some files'}`
      }
      const base = CHANGES[change] ?? change
      return reason ? `${base}: ${reason}` : base
    }
    case 'verification.changed': {
      const { change, state } = event.payload
      if (change === 'started') return 'Checks started'
      if (change === 'finished') return `Checks finished: ${state ?? 'done'}`
      if (change === 'cancelled') return 'Checks cancelled'
      if (change === 'error') return 'Checks could not be run'
      return null // one step along: not worth a line of its own
    }
    case 'review.changed': {
      const { change, reviewerId, verdict } = event.payload
      const who = nameOf(reviewerId)
      if (change === 'requested') return `Review asked of ${who}`
      if (change === 'started') return `${who} started reading`
      if (change === 'submitted') {
        return `${who} handed in a review${verdict ? ` (${verdict.replace('_', ' ')})` : ''}`
      }
      return change === 'cancelled'
        ? `Review by ${who} dropped`
        : `Review by ${who} could not be finished`
    }
    default:
      return null
  }
}

export const TIMELINE_LIMIT = 500

export function timelineOf(
  events: readonly ShokubaEvent[],
  nameOf: (employeeId: string) => string,
): { entries: TimelineEntry[]; truncated: boolean } {
  const entries: TimelineEntry[] = []
  for (const event of events) {
    const text = timelineText(event, nameOf)
    // A reason kept with an event can name a folder (why a task had none of its own).
    if (text !== null) {
      entries.push({ seq: event.seq, ts: event.ts, source: event.source, text: scrubPaths(text) })
    }
  }
  return entries.length > TIMELINE_LIMIT
    ? { entries: entries.slice(-TIMELINE_LIMIT), truncated: true }
    : { entries, truncated: false }
}
