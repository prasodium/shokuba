import { useState } from 'react'
import { isConflictNote } from '@shared/git'
import { dependentsOf } from '@shared/missions/graph'
import type { Mission, Task } from '@shared/missions'
import { dispatchHint } from '../missions/hints'
import { TASK_STATUS_LABELS } from '../missions/labels'
import { useMissions } from '../store/missions'
import { useOffice } from '../store/office'
import { TaskChangesView } from './TaskChangesView'
import { TaskReviewView } from './TaskReviewView'
import { TaskVerificationView } from './TaskVerificationView'
import { reviewConcern } from '../reviews/summary'
import { acceptConcern, acceptQuestion } from '../verification/summary'

interface Props {
  task: Task
  mission: Mission
  tasks: readonly Task[]
  onEdit(): void
}

const EDITABLE = new Set(['pending', 'ready', 'changes_requested', 'blocked'])

function TaskPill({ status }: { status: Task['status'] }) {
  return (
    <span className="task-pill" data-status={status}>
      {TASK_STATUS_LABELS[status]}
    </span>
  )
}

/** One task, with what a person can do about it. */
export function TaskDetail({ task, mission, tasks, onEdit }: Props) {
  const employees = useOffice((s) => s.employees)
  const views = useOffice((s) => s.views)
  const taskAction = useMissions((s) => s.taskAction)
  const removeTask = useMissions((s) => s.removeTask)
  const [sendingBack, setSendingBack] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const assignee = employees.find((e) => e.id === task.assigneeId)
  const hint = dispatchHint(
    task,
    mission,
    assignee?.name ?? null,
    task.assigneeId ? views[task.assigneeId] : undefined,
  )
  const closed = task.status === 'done' || task.status === 'cancelled'
  const canRemove =
    task.attempts === 0 &&
    (task.status === 'pending' || task.status === 'ready' || task.status === 'cancelled') &&
    dependentsOf(task.id, tasks).length === 0

  /**
   * Accepting is the person's call, but if the checks did not pass, or a reviewer asked for
   * changes, they are told before it is done. Neither is ever a block.
   */
  async function accept(): Promise<void> {
    const concerns: Array<string | null> = []
    try {
      concerns.push(acceptConcern(await window.shokuba.checks.forTask(task.id)))
    } catch {
      // If the checks cannot be read, accepting is not held up by that.
    }
    try {
      const review = await window.shokuba.reviews.forTask(task.id)
      const name = employees.find((e) => e.id === review.latest?.reviewerId)?.name ?? 'The reviewer'
      concerns.push(reviewConcern(review, name))
    } catch {
      // Nor by a review that cannot be read.
    }
    const question = acceptQuestion(concerns)
    if (question && !window.confirm(question)) return
    await run(() => taskAction(task.id, { action: 'accept' }))
  }

  async function run(work: () => Promise<{ ok: boolean; error?: string }>): Promise<void> {
    setError(null)
    const outcome = await work()
    if (!outcome.ok) setError(outcome.error ?? 'That did not work')
  }

  return (
    <section className="task-detail" aria-label={`Task: ${task.title}`}>
      <div className="task-head">
        <h3>{task.title}</h3>
        <TaskPill status={task.status} />
      </div>

      <dl className="meta">
        <div>
          <dt>Assigned to</dt>
          <dd>
            {task.assigneeId
              ? assignee
                ? `${assignee.name} · ${assignee.role}`
                : 'Removed employee'
              : 'Nobody yet'}
          </dd>
        </div>
        <div>
          <dt>Priority</dt>
          <dd>{task.priority}</dd>
        </div>
        <div>
          <dt>Attempts</dt>
          <dd>{task.attempts}</dd>
        </div>
      </dl>

      {task.description && <p className="task-description">{task.description}</p>}
      {hint && <p className="hint hint-soft">{hint}</p>}

      {task.dependsOn.length > 0 && (
        <div className="task-block">
          <h4>Waits for</h4>
          <ul className="deps">
            {task.dependsOn.map((id) => {
              const dependency = tasks.find((t) => t.id === id)
              return dependency ? (
                <li key={id}>
                  {dependency.title} <TaskPill status={dependency.status} />
                </li>
              ) : null
            })}
          </ul>
        </div>
      )}

      {task.summary && (
        <div className="task-block">
          <h4>What the agent says it did</h4>
          <blockquote className="claim">{task.summary}</blockquote>
          <p className="muted">
            This is the agent&apos;s own account. Nothing here has been checked.
          </p>
        </div>
      )}
      {task.status !== 'pending' && (
        <TaskChangesView
          taskId={task.id}
          assignee={assignee?.name ?? null}
          version={`${task.status}:${task.updatedAt}`}
        />
      )}
      {task.status !== 'pending' && task.status !== 'ready' && (
        <TaskVerificationView
          taskId={task.id}
          status={task.status}
          version={`${task.status}:${task.updatedAt}`}
        />
      )}
      {task.status !== 'pending' && task.status !== 'ready' && (
        <TaskReviewView
          taskId={task.id}
          status={task.status}
          assigneeId={task.assigneeId}
          version={`${task.status}:${task.updatedAt}`}
        />
      )}
      {task.status === 'blocked' && task.blockedReason && (
        <div className="task-block">
          <h4>Why it is blocked</h4>
          <p>{task.blockedReason}</p>
        </div>
      )}
      {task.reviewNote &&
        (task.status === 'changes_requested' || task.status === 'in_progress') && (
          <div className="task-block">
            <h4>{isConflictNote(task.reviewNote) ? 'Sent back automatically' : 'Your feedback'}</h4>
            <p>{task.reviewNote}</p>
          </div>
        )}

      {task.status === 'submitted' && !sendingBack && (
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => void accept()}>
            Accept
          </button>
          <button type="button" className="btn" onClick={() => setSendingBack(true)}>
            Request changes…
          </button>
        </div>
      )}

      {task.status === 'submitted' && sendingBack && (
        <form
          className="send-back"
          onSubmit={(event) => {
            event.preventDefault()
            void run(async () => {
              const outcome = await taskAction(task.id, { action: 'request-changes', note })
              if (outcome.ok) {
                setSendingBack(false)
                setNote('')
              }
              return outcome
            })
          }}
        >
          <label className="field">
            <span>What needs to change? (the agent will be told)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={2000}
              required
              autoFocus
            />
          </label>
          <div className="actions">
            <button type="submit" className="btn btn-primary">
              Send back
            </button>
            <button type="button" className="btn" onClick={() => setSendingBack(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {!sendingBack && (
        <div className="actions">
          {task.status === 'blocked' && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void run(() => taskAction(task.id, { action: 'retry' }))}
            >
              Retry
            </button>
          )}
          {EDITABLE.has(task.status) && (
            <button type="button" className="btn" onClick={onEdit}>
              Edit
            </button>
          )}
          {!closed && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void run(() => taskAction(task.id, { action: 'cancel' }))}
            >
              Cancel task
            </button>
          )}
          {canRemove && (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void run(() => removeTask(task.id))}
            >
              Remove
            </button>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
    </section>
  )
}
