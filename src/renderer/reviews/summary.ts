import type { Finding, FindingSeverity, Review, ReviewVerdict, TaskReview } from '@shared/reviews'

export const VERDICT_LABELS: Record<ReviewVerdict, string> = {
  approve: 'approves the work',
  request_changes: 'asks for changes',
  comment: 'has comments',
}

export const SEVERITY_LABELS: Record<FindingSeverity, string> = {
  blocker: 'Blocker',
  major: 'Major',
  minor: 'Minor',
  nit: 'Nit',
}

const SEVERITY_ORDER: readonly FindingSeverity[] = ['blocker', 'major', 'minor', 'nit']

/** One line on where a review stands, in the reviewer's name. */
export function reviewHeadline(review: Review, reviewer: string): string {
  switch (review.state) {
    case 'queued':
      return `Waiting for ${reviewer} to start reading`
    case 'in_progress':
      return `${reviewer} is reading the change…`
    case 'submitted':
      return `${reviewer} ${review.verdict ? VERDICT_LABELS[review.verdict] : 'has handed in a review'}`
    case 'cancelled':
      return review.note ?? 'The review was dropped because the work changed'
    case 'error':
      return review.note ?? 'The review could not be finished'
  }
}

/** Which way a review points, for colouring: good, bad, in between. */
export function reviewTone(review: Review): 'good' | 'bad' | 'neutral' {
  if (review.state !== 'submitted') return 'neutral'
  if (review.verdict === 'approve') return 'good'
  if (review.verdict === 'request_changes') return 'bad'
  return 'neutral'
}

/** The findings, worst first; ones of equal weight stay in the order the reviewer gave them. */
export function sortedFindings(review: Review): Finding[] {
  return [...review.findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  )
}

/** "1 blocker, 2 minor" — how many findings of each kind, worst first. */
export function findingCounts(review: Review): string {
  const parts = SEVERITY_ORDER.flatMap((severity) => {
    const count = review.findings.filter((f) => f.severity === severity).length
    return count > 0 ? [`${count} ${SEVERITY_LABELS[severity].toLowerCase()}`] : []
  })
  return parts.length > 0 ? parts.join(', ') : 'no findings'
}

/** Where a finding points: the file, and the line if the reviewer gave one. */
export function findingPlace(finding: Finding): string | null {
  if (!finding.file) return null
  return finding.line ? `${finding.file}:${finding.line}` : finding.file
}

const REVIEWABLE = new Set(['submitted', 'changes_requested', 'blocked'])

/** Whether a review can be asked for now: work in its own folder, stopped, and none already under way. */
export function canAskForReview(review: TaskReview, status: string): boolean {
  if (review.repoRoot === null || !REVIEWABLE.has(status)) return false
  const state = review.latest?.state
  return state !== 'queued' && state !== 'in_progress'
}

/** Who could review a task: anyone but the person who did it. */
export function reviewerChoices<T extends { id: string }>(
  employees: readonly T[],
  assigneeId: string | null,
): T[] {
  return employees.filter((employee) => employee.id !== assigneeId)
}

/** Who to suggest: the project's own reviewer if they can do this one, otherwise no one in particular. */
export function suggestedReviewer(
  review: TaskReview,
  choices: ReadonlyArray<{ id: string }>,
): string {
  const wanted = review.settings?.reviewerId
  return wanted && choices.some((c) => c.id === wanted) ? wanted : (choices[0]?.id ?? '')
}

/**
 * What gives pause before a person accepts work a reviewer asked changes for, or null. It only
 * informs: a review is one employee's opinion, and the person decides. A review of an earlier
 * version of the work says nothing about this one, so it is not raised.
 */
export function reviewConcern(review: TaskReview, reviewer: string): string | null {
  const latest = review.latest
  if (!latest || review.outOfDate) return null
  if (latest.state !== 'submitted' || latest.verdict !== 'request_changes') return null
  return `${reviewer} asked for changes (${findingCounts(latest)}).`
}
