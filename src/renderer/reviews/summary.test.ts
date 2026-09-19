import { describe, expect, it } from 'vitest'
import type { Finding, Review, TaskReview } from '@shared/reviews'
import {
  canAskForReview,
  findingCounts,
  findingPlace,
  reviewConcern,
  reviewHeadline,
  reviewerChoices,
  reviewTone,
  sortedFindings,
  suggestedReviewer,
} from './summary'

const finding = (patch: Partial<Finding>): Finding => ({
  severity: 'minor',
  file: null,
  line: null,
  note: 'Something.',
  ...patch,
})
const review = (patch: Partial<Review>): Review => ({
  id: 'r1',
  taskId: 't1',
  reviewerId: 'sora',
  commit: 'a'.repeat(40),
  state: 'submitted',
  verdict: 'comment',
  summary: 'Fine.',
  findings: [],
  requestedBy: 'manual',
  createdAt: 't',
  startedAt: 't',
  submittedAt: 't',
  note: null,
  ...patch,
})
const shown = (latest: Review | null, patch: Partial<TaskReview> = {}): TaskReview => ({
  repoRoot: '/p',
  settings: { repoRoot: '/p', reviewerId: null, auto: false },
  reason: null,
  latest,
  outOfDate: false,
  ...patch,
})

describe('reviewHeadline', () => {
  it('names the reviewer and what they concluded', () => {
    expect(reviewHeadline(review({ verdict: 'approve' }), 'Sora')).toBe('Sora approves the work')
    expect(reviewHeadline(review({ verdict: 'request_changes' }), 'Sora')).toBe(
      'Sora asks for changes',
    )
    expect(reviewHeadline(review({ verdict: 'comment' }), 'Sora')).toBe('Sora has comments')
  })

  it('says where an unfinished review stands', () => {
    expect(reviewHeadline(review({ state: 'queued', verdict: null }), 'Sora')).toBe(
      'Waiting for Sora to start reading',
    )
    expect(reviewHeadline(review({ state: 'in_progress', verdict: null }), 'Sora')).toBe(
      'Sora is reading the change…',
    )
  })

  it('says why a review did not finish, in its own words when it has them', () => {
    expect(reviewHeadline(review({ state: 'cancelled', note: 'The work changed.' }), 'Sora')).toBe(
      'The work changed.',
    )
    expect(reviewHeadline(review({ state: 'cancelled', note: null }), 'Sora')).toBe(
      'The review was dropped because the work changed',
    )
    expect(reviewHeadline(review({ state: 'error', note: null }), 'Sora')).toBe(
      'The review could not be finished',
    )
  })
})

describe('reviewTone', () => {
  it('is good for an approval, bad for a request for changes, and neutral otherwise', () => {
    expect(reviewTone(review({ verdict: 'approve' }))).toBe('good')
    expect(reviewTone(review({ verdict: 'request_changes' }))).toBe('bad')
    expect(reviewTone(review({ verdict: 'comment' }))).toBe('neutral')
    expect(reviewTone(review({ state: 'in_progress', verdict: null }))).toBe('neutral')
    expect(reviewTone(review({ state: 'cancelled', verdict: 'request_changes' }))).toBe('neutral')
  })
})

describe('findings', () => {
  const mixed = review({
    findings: [
      finding({ severity: 'nit', note: 'a' }),
      finding({ severity: 'blocker', note: 'b' }),
      finding({ severity: 'minor', note: 'c' }),
      finding({ severity: 'minor', note: 'd' }),
      finding({ severity: 'major', note: 'e' }),
    ],
  })

  it('come worst first, and keep the reviewer’s order among equals', () => {
    expect(sortedFindings(mixed).map((f) => f.note)).toEqual(['b', 'e', 'c', 'd', 'a'])
    expect(mixed.findings.map((f) => f.note)).toEqual(['a', 'b', 'c', 'd', 'e']) // not reordered in place
  })

  it('are counted by kind', () => {
    expect(findingCounts(mixed)).toBe('1 blocker, 1 major, 2 minor, 1 nit')
    expect(findingCounts(review({}))).toBe('no findings')
  })

  it('point at a file and line when the reviewer gave them', () => {
    expect(findingPlace(finding({ file: 'src/a.ts', line: 12 }))).toBe('src/a.ts:12')
    expect(findingPlace(finding({ file: 'src/a.ts' }))).toBe('src/a.ts')
    expect(findingPlace(finding({}))).toBeNull()
  })
})

describe('canAskForReview', () => {
  it('needs work in its own folder that the agent has stopped changing', () => {
    expect(canAskForReview(shown(null), 'submitted')).toBe(true)
    expect(canAskForReview(shown(null), 'changes_requested')).toBe(true)
    expect(canAskForReview(shown(null), 'blocked')).toBe(true)
    expect(canAskForReview(shown(null), 'in_progress')).toBe(false)
    expect(canAskForReview(shown(null), 'done')).toBe(false)
    expect(canAskForReview(shown(null, { repoRoot: null }), 'submitted')).toBe(false)
  })

  it('is not offered while one is waiting or being read, and is again once it is over', () => {
    expect(canAskForReview(shown(review({ state: 'queued' })), 'submitted')).toBe(false)
    expect(canAskForReview(shown(review({ state: 'in_progress' })), 'submitted')).toBe(false)
    expect(canAskForReview(shown(review({ state: 'submitted' })), 'submitted')).toBe(true)
    expect(canAskForReview(shown(review({ state: 'cancelled' })), 'submitted')).toBe(true)
  })
})

describe('who can review', () => {
  const people = [{ id: 'ren' }, { id: 'sora' }, { id: 'mika' }]

  it('is anyone but whoever did the work', () => {
    expect(reviewerChoices(people, 'ren').map((p) => p.id)).toEqual(['sora', 'mika'])
    expect(reviewerChoices(people, null)).toHaveLength(3)
  })

  it('suggests the project’s reviewer if they can do this one, otherwise the first choice', () => {
    const settings = (reviewerId: string | null) =>
      shown(null, { settings: { repoRoot: '/p', reviewerId, auto: false } })
    const choices = reviewerChoices(people, 'ren')
    expect(suggestedReviewer(settings('mika'), choices)).toBe('mika')
    expect(suggestedReviewer(settings('ren'), choices)).toBe('sora') // the author cannot
    expect(suggestedReviewer(settings(null), choices)).toBe('sora')
    expect(suggestedReviewer(settings(null), [])).toBe('')
  })
})

describe('reviewConcern', () => {
  const asked = review({
    verdict: 'request_changes',
    findings: [finding({ severity: 'major' }), finding({ severity: 'nit' })],
  })

  it('names who asked for changes, and how much they found', () => {
    expect(reviewConcern(shown(asked), 'Sora')).toBe('Sora asked for changes (1 major, 1 nit).')
  })

  it('says nothing for an approval, a comment, or a review that is not finished', () => {
    expect(reviewConcern(shown(review({ verdict: 'approve' })), 'Sora')).toBeNull()
    expect(reviewConcern(shown(review({ verdict: 'comment' })), 'Sora')).toBeNull()
    expect(reviewConcern(shown(review({ state: 'in_progress', verdict: null })), 'Sora')).toBeNull()
    expect(reviewConcern(shown(null), 'Sora')).toBeNull()
  })

  it('says nothing about a review of an earlier version of the work', () => {
    expect(reviewConcern(shown(asked, { outOfDate: true }), 'Sora')).toBeNull()
  })
})
