import { useEffect, useRef, useState, type FormEvent } from 'react'
import { PERMISSION_MODES, type Employee, type PermissionMode } from '@shared/employees'
import { useOffice } from '../store/office'

const COLORS = ['#e8893a', '#6f9a5b', '#5b8fc7', '#c76b8f', '#8f7bd1', '#d1b34a']
const NAMES = ['Mika', 'Ren', 'Sora', 'Aiko', 'Haru', 'Yui', 'Kaito', 'Nao']
const ROLES = ['Engineer', 'Reviewer', 'QA', 'Architect', 'Designer', 'Researcher']
const MODEL_HINTS = ['sonnet', 'opus', 'haiku']

const PERMISSION_LABELS: Record<PermissionMode, string> = {
  default: 'Ask before edits and commands (recommended)',
  acceptEdits: 'Accept file edits automatically, ask for commands',
  plan: 'Plan only — no changes until you approve',
}

interface Props {
  open: boolean
  /** The employee being edited, or null to create one. */
  editing: Employee | null
  onClose(): void
}

/** Create or edit an employee. Validation lives in main; its messages are shown here. */
export function EmployeeDialog({ open, editing, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const providers = useOffice((s) => s.providers)
  const employees = useOffice((s) => s.employees)
  const views = useOffice((s) => s.views)
  const info = useOffice((s) => s.info)
  const createEmployee = useOffice((s) => s.createEmployee)
  const updateEmployee = useOffice((s) => s.updateEmployee)
  const archiveEmployee = useOffice((s) => s.archiveEmployee)
  const refreshProviders = useOffice((s) => s.refreshProviders)

  const [name, setName] = useState('')
  const [role, setRole] = useState('Engineer')
  const [providerId, setProviderId] = useState('')
  const [folder, setFolder] = useState('')
  const [model, setModel] = useState('')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default')
  const [color, setColor] = useState(COLORS[0] as string)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const running = editing ? views[editing.id]?.pid != null : false

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  // Reset the form each time it opens.
  useEffect(() => {
    if (!open) return
    setError(null)
    setBusy(false)
    void refreshProviders()
    if (editing) {
      setName(editing.name)
      setRole(editing.role)
      setProviderId(editing.providerId)
      setFolder(editing.workingDirectory)
      setModel(editing.model ?? '')
      setPermissionMode(editing.permissionMode)
      setColor(editing.color)
    } else {
      setName(NAMES[employees.length % NAMES.length] as string)
      setRole('Engineer')
      setFolder('')
      setModel('')
      setPermissionMode('default')
      setColor(COLORS[employees.length % COLORS.length] as string)
    }
    // `employees.length` only picks a friendly default; it must not reset a form being edited,
    // so it is deliberately not a dependency.
  }, [open, editing])

  // Pick a sensible provider once they are known: a working real one, else the demo.
  useEffect(() => {
    if (!open || editing || providerId) return
    const usable = providers.find(
      (p) => !p.simulated && p.installation.found && !p.installation.problem,
    )
    const fallback = providers.find((p) => p.simulated)
    const chosen = usable ?? fallback ?? providers[0]
    if (chosen) setProviderId(chosen.id)
  }, [open, editing, providerId, providers])

  const provider = providers.find((p) => p.id === providerId)

  // The demo agent never touches files, so a harmless default folder saves a step.
  useEffect(() => {
    if (open && !editing && provider?.simulated && !folder && info) setFolder(info.homeDirectory)
  }, [open, editing, provider, folder, info])

  async function browse(): Promise<void> {
    const picked = await window.shokuba.system.pickDirectory()
    if (picked) setFolder(picked)
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const common = { name, role, color }
    if (editing) {
      const result = await updateEmployee(editing.id, {
        ...common,
        ...(running
          ? {}
          : { providerId, workingDirectory: folder, permissionMode, model: model || null }),
      })
      setBusy(false)
      if (result.error) setError(result.error)
      else onClose()
    } else {
      const result = await createEmployee({
        ...common,
        providerId,
        workingDirectory: folder,
        permissionMode,
        ...(model ? { model } : {}),
      })
      setBusy(false)
      if ('error' in result) setError(result.error)
      else onClose()
    }
  }

  async function remove(): Promise<void> {
    if (!editing) return
    setBusy(true)
    await archiveEmployee(editing.id)
    setBusy(false)
    onClose()
  }

  const modes = provider?.permissionModes ?? [...PERMISSION_MODES]
  const launchLocked = running

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      onClose={onClose}
      aria-labelledby="employee-dialog-title"
    >
      <form onSubmit={(event) => void submit(event)} className="form">
        <h2 id="employee-dialog-title">{editing ? `Edit ${editing.name}` : 'New employee'}</h2>

        <div className="grid-2">
          <label className="field">
            <span>Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              required
              autoFocus
            />
          </label>
          <label className="field">
            <span>Role</span>
            <input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              maxLength={60}
              list="roles"
              required
            />
            <datalist id="roles">
              {ROLES.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </label>
        </div>

        <label className="field">
          <span>Provider</span>
          <select
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            disabled={launchLocked}
            required
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
                {!p.installation.found
                  ? ' — not found'
                  : p.installation.problem
                    ? ' — unavailable'
                    : ''}
              </option>
            ))}
          </select>
          {provider && (
            <small className={provider.installation.problem ? 'field-error' : 'muted'}>
              {provider.installation.problem ??
                (provider.simulated
                  ? 'Scripted demo: shows the office and terminal working. No AI runs and no files are touched.'
                  : `Found${provider.installation.version ? ` v${provider.installation.version}` : ''} at ${provider.installation.path}`)}
            </small>
          )}
        </label>

        <label className="field">
          <span>Working folder</span>
          <div className="row">
            <input
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="/path/to/project"
              disabled={launchLocked}
              required
              spellCheck={false}
            />
            <button
              type="button"
              className="btn"
              onClick={() => void browse()}
              disabled={launchLocked}
            >
              Browse…
            </button>
          </div>
          <small className="muted">The agent starts here and works on the files here.</small>
        </label>

        <div className="grid-2">
          {provider?.supportsModelSelection && (
            <label className="field">
              <span>Model (optional)</span>
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                list="models"
                placeholder="provider default"
                disabled={launchLocked}
              />
              <datalist id="models">
                {MODEL_HINTS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
          )}
          <label className="field">
            <span>Permissions</span>
            <select
              value={permissionMode}
              onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}
              disabled={launchLocked}
            >
              {modes.map((mode) => (
                <option key={mode} value={mode}>
                  {PERMISSION_LABELS[mode as PermissionMode]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <fieldset className="field">
          <legend>Shirt colour</legend>
          <div className="swatches">
            {COLORS.map((c) => (
              <label key={c} className="swatch-choice" title={c}>
                <input
                  type="radio"
                  name="color"
                  value={c}
                  checked={color === c}
                  onChange={() => setColor(c)}
                />
                <span style={{ background: c }} />
              </label>
            ))}
          </div>
        </fieldset>

        {launchLocked && (
          <p className="muted">
            Stop this employee to change their provider, folder, model or permissions.
          </p>
        )}
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}

        <div className="dialog-actions">
          {editing && (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void remove()}
              disabled={busy || running}
            >
              Remove
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !providerId}>
            {editing ? 'Save' : 'Create employee'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
