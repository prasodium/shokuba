import { useEffect, useState } from 'react'
import type { TaskReview } from '@shared/reviews'
import { latestReviewSeq } from '../git/events'
import { errorMessage } from '../lib/errors'
import {
  canAskForReview,
  findingCounts,
  findingPlace,
  reviewerChoices,
  reviewHeadline,
  reviewTone,
  SEVERITY_LABELS,
  sortedFindings,
  suggestedReviewer,
} from '../reviews/summary'
import { useEvents } from '../store/events'
import { useOffice } from '../store/office'

interface Props {
  taskId: string
  /** The task's status, for whether a review can be asked for. */
  status: string
  assigneeId: string | null
  /** Changes when the task moves, so what is shown is read again. */
  version: string
}

/**
 * What a different employee found when they read a task's work: the change and what was asked
 * for, never the author's own account. It is advice. Accepting stays with the person.
 */
export function TaskReviewView({ taskId, status, assigneeId, version }: Props) {
  const employees = useOffice((s) => s.employees)
  const [review, setReview] = useState<TaskReview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const [saved, setSaved] = useState(0)
  const seq = useEvents((s) => latestReviewSeq(s.events, taskId))

  useEffect(() => {
    let current = true
    window.shokuba.reviews
      .forTask(taskId)
      .then((result) => current && setReview(result))
      .catch((e: unknown) => current && setError(errorMessage(e)))
    return () => {
      current = false
    }
  }, [taskId, version, seq, saved])

  if (error) return <p className="field-error">{error}</p>
  if (!review) return null
  // Not handed out yet: nothing to show unless there is a reason.
  if (review.repoRoot === null && review.reason === null) return null

  const nameOf = (id: string): string => employees.find((e) => e.id === id)?.name ?? 'The reviewer'
  const choices = reviewerChoices(employees, assigneeId)
  const reviewer = chosen ?? suggestedReviewer(review, choices)
  const latest = review.latest

  async function ask(): Promise<void> {
    setError(null)
    try {
      await window.shokuba.reviews.request(taskId, reviewer)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function saveSettings(reviewerId: string | null, auto: boolean): Promise<void> {
    if (!review?.repoRoot) return
    setError(null)
    try {
      await window.shokuba.reviews.saveSettings({ repoRoot: review.repoRoot, reviewerId, auto })
      setSaved((n) => n + 1)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <div className="task-block">
      <h4>Review</h4>

      {review.repoRoot === null ? (
        <p className="muted">{review.reason}</p>
      ) : (
        <>
          {latest ? (
            <>
              <p className={`verdict verdict-${reviewTone(latest)}`}>
                {reviewHeadline(latest, nameOf(latest.reviewerId))}
                <span className="muted">
                  {' '}
                  · on commit {latest.commit.slice(0, 8)}
                  {latest.state === 'submitted' ? ` · ${findingCounts(latest)}` : ''}
                  {latest.requestedBy === 'auto' ? ' · asked for automatically' : ''}
                </span>
              </p>
              {review.outOfDate && (
                <p className="hint hint-soft">
                  The agent has changed the work since this review, so it may no longer apply.
                </p>
              )}
              {latest.state === 'submitted' && latest.summary && (
                <p className="review-summary">{latest.summary}</p>
              )}
              {latest.state === 'submitted' && latest.findings.length > 0 && (
                <ul className="findings" aria-label="Findings">
                  {sortedFindings(latest).map((finding, index) => (
                    <li key={index} className="finding" data-severity={finding.severity}>
                      <span className="finding-severity">{SEVERITY_LABELS[finding.severity]}</span>
                      <span className="finding-note">
                        {findingPlace(finding) && (
                          <code className="finding-place">{findingPlace(finding)}</code>
                        )}
                        {finding.note}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="muted">
              {review.settings?.auto
                ? 'A review will be asked for when the agent submits its work.'
                : 'No one has reviewed this work yet.'}
            </p>
          )}

          {canAskForReview(review, status) && (
            <div className="row">
              <select
                aria-label="Who should review it"
                value={reviewer}
                onChange={(event) => setChosen(event.target.value)}
              >
                {choices.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name} · {employee.role}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!reviewer}
                onClick={() => void ask()}
              >
                {latest ? 'Ask for another review' : 'Ask for a review'}
              </button>
            </div>
          )}

          {review.settings && (
            <details className="review-settings">
              <summary>Reviews for this project</summary>
              <div className="row">
                <select
                  aria-label="Who reviews this project’s work"
                  value={review.settings.reviewerId ?? ''}
                  onChange={(event) =>
                    void saveSettings(event.target.value || null, review.settings?.auto ?? false)
                  }
                >
                  <option value="">No one in particular</option>
                  {employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.name} · {employee.role}
                    </option>
                  ))}
                </select>
                <label className="check-enabled">
                  <input
                    type="checkbox"
                    checked={review.settings.auto}
                    disabled={review.settings.reviewerId === null}
                    onChange={(event) =>
                      void saveSettings(review.settings?.reviewerId ?? null, event.target.checked)
                    }
                  />
                  Ask for a review whenever work is submitted
                </label>
              </div>
              <p className="muted">
                If the reviewer is the one who did the work, no review is asked for.
              </p>
            </details>
          )}
          <p className="muted">
            A review is one employee’s opinion of the change. It does not accept or reject anything:
            you decide. The reviewer reads the code as submitted, not the agent’s account of it.
          </p>
        </>
      )}
    </div>
  )
}
