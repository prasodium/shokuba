import { useEffect, useRef, useState, type FormEvent } from 'react'
import { DEPARTMENT_COLORS, type Department } from '@shared/departments'
import { BLANK_DRAFT, draftOf, hasChanges, savable, type Draft } from '../departments/draft'
import { useDepartments } from '../store/departments'

interface Props {
  open: boolean
  onClose(): void
}

/**
 * Add, rename, colour and remove departments. A department's people sit together in the office under
 * a plate in its colour. Removing one removes nobody: they are just in no department.
 */
export function DepartmentsDialog({ open, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { departments, headcounts, create, update, archive } = useDepartments()
  /** The department being edited, or `null` for a new one. */
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(BLANK_DRAFT)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const selected = departments.find((d) => d.id === selectedId)
  const changed = hasChanges(draft, selected)
  const members = selected ? (headcounts[selected.id] ?? 0) : 0

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  // Each time it opens, start on the first department, or a new one if there are none.
  useEffect(() => {
    if (!open) return
    setError(null)
    const first = departments[0]
    setSelectedId(first?.id ?? null)
    setDraft(first ? draftOf(first) : BLANK_DRAFT)
    // Only when it opens: a change to the list must not throw away what is being typed.
  }, [open])

  // A department that was removed under the form: fall back to the first one.
  useEffect(() => {
    if (!open || selectedId === null || selected) return
    const first = departments[0]
    setSelectedId(first?.id ?? null)
    setDraft(first ? draftOf(first) : BLANK_DRAFT)
  }, [open, departments, selectedId, selected])

  function mayDiscard(): boolean {
    return !changed || window.confirm('Discard the changes you have made to this department?')
  }

  function choose(department: Department | null): void {
    setError(null)
    setSelectedId(department?.id ?? null)
    setDraft(department ? draftOf(department) : BLANK_DRAFT)
  }

  async function run<T>(
    work: () => Promise<{ ok: true; value: T } | { ok: false; error: string }>,
  ) {
    setBusy(true)
    setError(null)
    const outcome = await work()
    setBusy(false)
    if (!outcome.ok) setError(outcome.error)
    return outcome
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault()
    const input = savable(draft)
    if (selected) {
      const outcome = await run(() => update(selected.id, input))
      if (outcome.ok) setDraft(draftOf(outcome.value))
    } else {
      const outcome = await run(() => create(input))
      if (outcome.ok) choose(outcome.value)
    }
  }

  async function remove(): Promise<void> {
    if (!selected) return
    const who =
      members === 0
        ? 'Nobody is in it.'
        : `Its ${members} ${members === 1 ? 'person stays' : 'people stay'}, with no department.`
    if (!window.confirm(`Remove ${selected.name}? ${who}`)) return
    const outcome = await run(() => archive(selected.id))
    if (outcome.ok) choose(departments.find((d) => d.id !== selected.id) ?? null)
  }

  return (
    <dialog
      ref={dialogRef}
      className="dialog dialog-wide"
      onClose={onClose}
      aria-labelledby="departments-title"
    >
      <div className="form">
        <h2 id="departments-title">Departments</h2>
        <p className="muted">
          A department’s people sit together in the office, under a plate with its name in its
          colour, and the roster groups them. It is separate from a team: who reports to whom is set
          on each employee.
        </p>

        <div className="roles-layout">
          <ul className="roles-list" aria-label="Departments">
            {departments.map((department) => (
              <li key={department.id}>
                <button
                  type="button"
                  className={`roles-item ${department.id === selectedId ? 'is-selected' : ''}`}
                  aria-current={department.id === selectedId}
                  onClick={() => mayDiscard() && choose(department)}
                >
                  <span
                    className="swatch"
                    style={{ background: department.color }}
                    aria-hidden="true"
                  />
                  <span>{department.name}</span>
                  <small className="tag">{headcounts[department.id] ?? 0}</small>
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                className={`roles-item roles-new ${selectedId === null ? 'is-selected' : ''}`}
                onClick={() => mayDiscard() && choose(null)}
              >
                + New department
              </button>
            </li>
          </ul>

          <form onSubmit={(event) => void save(event)} className="roles-form">
            <label className="field">
              <span>Name</span>
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                maxLength={60}
                required
              />
            </label>

            <fieldset className="field">
              <legend>Colour of its plate</legend>
              <div className="swatches">
                {DEPARTMENT_COLORS.map((color) => (
                  <label key={color} className="swatch-choice" title={color}>
                    <input
                      type="radio"
                      name="department-color"
                      value={color}
                      checked={draft.color.toLowerCase() === color}
                      onChange={() => setDraft({ ...draft, color })}
                      aria-label={color}
                    />
                    <span style={{ background: color }} />
                  </label>
                ))}
              </div>
            </fieldset>

            {selected && (
              <small className="muted">
                {members === 0
                  ? 'Nobody is in this department yet. Choose it when you edit an employee.'
                  : `${members} ${members === 1 ? 'person is' : 'people are'} in this department.`}
              </small>
            )}
            {error && (
              <p role="alert" className="field-error">
                {error}
              </p>
            )}

            <div className="dialog-actions">
              {selected && (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => void remove()}
                  disabled={busy}
                >
                  Remove
                </button>
              )}
              <span className="spacer" />
              <button type="submit" className="btn btn-primary" disabled={busy || !changed}>
                {selected ? 'Save' : 'Create department'}
              </button>
            </div>
          </form>
        </div>

        <div className="dialog-actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={() => mayDiscard() && onClose()}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  )
}
