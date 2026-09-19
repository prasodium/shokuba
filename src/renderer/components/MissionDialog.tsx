import { useEffect, useRef, useState, type FormEvent } from 'react'
import { PRIORITIES, type Mission, type Priority } from '@shared/missions'
import { useMissions } from '../store/missions'

interface Props {
  open: boolean
  editing: Mission | null
  onClose(): void
}

/** Create or edit a mission: a title, what it is for, and how urgent it is. */
export function MissionDialog({ open, editing, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const createMission = useMissions((s) => s.createMission)
  const updateMission = useMissions((s) => s.updateMission)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<Priority>('normal')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
    setPriority(editing?.priority ?? 'normal')
  }, [open, editing])

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const outcome = editing
      ? await updateMission(editing.id, { title, description, priority })
      : await createMission({ title, description, priority })
    setBusy(false)
    if (outcome.ok) onClose()
    else setError(outcome.error)
  }

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="mission-dialog-title">
      <form className="form" onSubmit={(event) => void submit(event)}>
        <h2 id="mission-dialog-title">{editing ? 'Edit mission' : 'New mission'}</h2>
        <label className="field">
          <span>What is the goal?</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            required
            autoFocus
            placeholder="Add OAuth login"
          />
        </label>
        <label className="field">
          <span>Details (optional)</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            maxLength={4000}
          />
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
            {editing ? 'Save' : 'Create mission'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
