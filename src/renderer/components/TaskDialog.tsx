import { useEffect, useRef, useState, type FormEvent } from 'react'
import { PRIORITIES, type Priority, type Task } from '@shared/missions'
import { TASK_STATUS_LABELS } from '../missions/labels'
import { useMissions } from '../store/missions'
import { useOffice } from '../store/office'

interface Props {
  open: boolean
  missionId: string
  /** Every task in the mission, for choosing dependencies. */
  tasks: readonly Task[]
  editing: Task | null
  onClose(): void
}

/** Create or edit a task: what to do, who does it, and what it has to wait for. */
export function TaskDialog({ open, missionId, tasks, editing, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const employees = useOffice((s) => s.employees)
  const createTask = useMissions((s) => s.createTask)
  const updateTask = useMissions((s) => s.updateTask)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [assigneeId, setAssigneeId] = useState('')
  const [priority, setPriority] = useState<Priority>('normal')
  const [dependsOn, setDependsOn] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Dependencies can only change before a task starts.
  const dependenciesLocked =
    editing !== null && editing.status !== 'pending' && editing.status !== 'ready'

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  useEffect(() => {
    if (!open) return
    setError(null)
    setBusy(false)
    setTitle(editing?.title ?? '')
    setDescription(editing?.description ?? '')
    setAssigneeId(editing?.assigneeId ?? '')
    setPriority(editing?.priority ?? 'normal')
    setDependsOn(editing?.dependsOn ?? [])
  }, [open, editing])

  const toggle = (id: string): void =>
    setDependsOn((current) =>
      current.includes(id) ? current.filter((d) => d !== id) : [...current, id],
    )

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const outcome = editing
      ? await updateTask(editing.id, {
          title,
          description,
          priority,
          assigneeId: assigneeId || null,
          ...(dependenciesLocked ? {} : { dependsOn }),
        })
      : await createTask({
          missionId,
          title,
          description,
          priority,
          assigneeId: assigneeId || null,
          dependsOn,
        })
    setBusy(false)
    if (outcome.ok) onClose()
    else setError(outcome.error)
  }

  const candidates = tasks.filter((task) => task.id !== editing?.id)

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="task-dialog-title">
      <form className="form" onSubmit={(event) => void submit(event)}>
        <h2 id="task-dialog-title">{editing ? 'Edit task' : 'New task'}</h2>
        <label className="field">
          <span>Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={160}
            required
            autoFocus
          />
        </label>
        <label className="field">
          <span>What should they do? (this is what the agent is told)</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={5}
            maxLength={8000}
          />
        </label>
        <div className="grid-2">
          <label className="field">
            <span>Assigned to</span>
            <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">Unassigned</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name} · {employee.role}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Priority</span>
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p[0]?.toUpperCase()}
                  {p.slice(1)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <fieldset className="field">
          <legend>Waits for (must be done first)</legend>
          {candidates.length === 0 ? (
            <small className="muted">There are no other tasks yet.</small>
          ) : (
            <div className="checks">
              {candidates.map((task) => (
                <label key={task.id} className="check">
                  <input
                    type="checkbox"
                    checked={dependsOn.includes(task.id)}
                    onChange={() => toggle(task.id)}
                    disabled={dependenciesLocked}
                  />
                  <span>{task.title}</span>
                  <small className="muted">{TASK_STATUS_LABELS[task.status]}</small>
                </label>
              ))}
            </div>
          )}
          {dependenciesLocked && (
            <small className="muted">Dependencies cannot change once a task has started.</small>
          )}
        </fieldset>

        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {editing ? 'Save' : 'Add task'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
