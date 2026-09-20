import { useEffect, useRef, useState, type FormEvent } from 'react'
import { MAX_INSTRUCTIONS, PERMISSION_MODES, type PermissionMode } from '@shared/employees'
import type { Role } from '@shared/roles'
import { BLANK_DRAFT, draftOf, hasChanges, savable, type Draft } from '../roles/draft'
import { useRoles } from '../store/roles'

const PERMISSION_LABELS: Record<PermissionMode, string> = {
  default: 'Ask before edits and commands (recommended)',
  acceptEdits: 'Accept file edits automatically, ask for commands',
  plan: 'Plan only — no changes until you approve',
}

interface Props {
  open: boolean
  onClose(): void
}

/**
 * Edit the roles new employees are hired from. A role is only a starting point: what someone was
 * hired as is their own copy, so nothing done here ever changes anyone already hired.
 */
export function RolesDialog({ open, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { roles, create, update, duplicate, archive, reset } = useRoles()
  /** The role being edited, or `null` for a new one. */
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(BLANK_DRAFT)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const selected = roles.find((role) => role.id === selectedId)
  const changed = hasChanges(draft, selected)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  // Each time it opens, start on the first role.
  useEffect(() => {
    if (!open) return
    setError(null)
    const first = roles[0]
    setSelectedId(first?.id ?? null)
    setDraft(first ? draftOf(first) : BLANK_DRAFT)
    // Only when it opens: a change to the list must not throw away what is being typed.
  }, [open])

  // A role that was removed or replaced under the form: fall back to the first one.
  useEffect(() => {
    if (!open || selectedId === null || selected) return
    const first = roles[0]
    setSelectedId(first?.id ?? null)
    setDraft(first ? draftOf(first) : BLANK_DRAFT)
  }, [open, roles, selectedId, selected])

  /** Whether to go on: yes if there is nothing to lose, or the person says to lose it. */
  function mayDiscard(): boolean {
    return !changed || window.confirm('Discard the changes you have made to this role?')
  }

  function choose(role: Role | null): void {
    setError(null)
    setSelectedId(role?.id ?? null)
    setDraft(role ? draftOf(role) : BLANK_DRAFT)
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

  async function copy(): Promise<void> {
    if (!selected || !mayDiscard()) return
    const outcome = await run(() => duplicate(selected.id))
    if (outcome.ok) choose(outcome.value)
  }

  async function restore(): Promise<void> {
    if (!selected) return
    const outcome = await run(() => reset(selected.id))
    if (outcome.ok) setDraft(draftOf(outcome.value))
  }

  async function remove(): Promise<void> {
    if (!selected) return
    const outcome = await run(() => archive(selected.id))
    if (outcome.ok) choose(roles.find((role) => role.id !== selected.id) ?? null)
  }

  return (
    <dialog
      ref={dialogRef}
      className="dialog dialog-wide"
      onClose={onClose}
      aria-labelledby="roles-title"
    >
      <div className="form">
        <h2 id="roles-title">Roles</h2>
        <p className="muted">
          A role is a starting point for hiring: a label, whether it leads a team, and what it is
          for. Changing or removing one never changes anyone already hired, because each employee
          keeps their own copy.
        </p>

        <div className="roles-layout">
          <ul className="roles-list" aria-label="Roles">
            {roles.map((role) => (
              <li key={role.id}>
                <button
                  type="button"
                  className={`roles-item ${role.id === selectedId ? 'is-selected' : ''}`}
                  aria-current={role.id === selectedId}
                  onClick={() => mayDiscard() && choose(role)}
                >
                  <span>{role.label}</span>
                  {role.builtin && <small className="tag">Shokuba’s</small>}
                  {role.isManager && <small className="tag">leads a team</small>}
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                className={`roles-item roles-new ${selectedId === null ? 'is-selected' : ''}`}
                onClick={() => mayDiscard() && choose(null)}
              >
                + New role
              </button>
            </li>
          </ul>

          <form onSubmit={(event) => void save(event)} className="roles-form">
            <label className="field">
              <span>Label</span>
              <input
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                maxLength={60}
                required
              />
              <small className="muted">Shown on the desk and in the roster.</small>
            </label>

            <label className="check">
              <input
                type="checkbox"
                checked={draft.isManager}
                onChange={(e) => setDraft({ ...draft, isManager: e.target.checked })}
              />
              <span>Leads a team, and is the one who talks to you</span>
            </label>

            <label className="field">
              <span>New employees start with</span>
              <select
                value={draft.permissionMode}
                onChange={(e) =>
                  setDraft({ ...draft, permissionMode: e.target.value as PermissionMode })
                }
              >
                {PERMISSION_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {PERMISSION_LABELS[mode]}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>What this role is for</span>
              <textarea
                value={draft.instructions}
                onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
                rows={8}
                maxLength={MAX_INSTRUCTIONS}
              />
              <small className="muted">The agent is told this when it starts.</small>
            </label>

            {selected?.builtin && (
              <small className="muted">
                One of Shokuba’s own roles. You can change it, and put it back to what Shokuba
                wrote, but not remove it.
              </small>
            )}
            {error && (
              <p role="alert" className="field-error">
                {error}
              </p>
            )}

            <div className="dialog-actions">
              {selected && !selected.builtin && (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => void remove()}
                  disabled={busy}
                >
                  Remove
                </button>
              )}
              {selected?.builtin && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => void restore()}
                  disabled={busy}
                >
                  Reset to Shokuba’s original
                </button>
              )}
              {selected && (
                <button type="button" className="btn" onClick={() => void copy()} disabled={busy}>
                  Duplicate
                </button>
              )}
              <span className="spacer" />
              <button type="submit" className="btn btn-primary" disabled={busy || !changed}>
                {selected ? 'Save' : 'Create role'}
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
