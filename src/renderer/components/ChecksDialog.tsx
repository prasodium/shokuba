import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_CHECK_STEPS,
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  type CheckKind,
  type CheckStepInput,
} from '@shared/verification'
import { errorMessage } from '../lib/errors'

interface Props {
  open: boolean
  /** The project (repository) the checks are for. */
  repoRoot: string | null
  repoName: string
  onClose(): void
}

interface Row {
  key: number
  kind: CheckKind
  name: string
  command: string
  /** In minutes, which is how a person thinks about it. */
  minutes: number
  enabled: boolean
}

let counter = 0
const blank = (kind: CheckKind = 'check'): Row => ({
  key: ++counter,
  kind,
  name: '',
  command: '',
  minutes: DEFAULT_TIMEOUT_SECONDS / 60,
  enabled: true,
})
const fromStep = (step: CheckStepInput): Row => ({
  key: ++counter,
  kind: step.kind,
  name: step.name,
  command: step.command,
  minutes: (step.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) / 60,
  enabled: step.enabled ?? true,
})

/**
 * Set up the commands Shokuba runs on the work agents submit for a project. They are yours: they
 * are stored in Shokuba and never read from the repository, so an agent cannot add or weaken one.
 * Nothing runs until the notice below has been acknowledged.
 */
export function ChecksDialog({ open, repoRoot, repoName, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [acknowledged, setAcknowledged] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [suggested, setSuggested] = useState<string | null>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  useEffect(() => {
    if (!open || !repoRoot) return
    let current = true
    setError(null)
    setSuggested(null)
    window.shokuba.checks
      .get(repoRoot)
      .then((settings) => {
        if (!current) return
        setAcknowledged(settings.acknowledged)
        setRows(settings.steps.map(fromStep))
      })
      .catch((e: unknown) => current && setError(errorMessage(e)))
    return () => {
      current = false
    }
  }, [open, repoRoot])

  const update = (key: number, patch: Partial<Row>): void =>
    setRows((all) => all.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  const move = (index: number, by: -1 | 1): void =>
    setRows((all) => {
      const next = [...all]
      const to = index + by
      if (to < 0 || to >= next.length) return all
      ;[next[index], next[to]] = [next[to] as Row, next[index] as Row]
      return next
    })

  async function suggest(): Promise<void> {
    if (!repoRoot) return
    setError(null)
    try {
      const found = await window.shokuba.checks.suggest(repoRoot)
      if (found.length === 0) {
        setSuggested('Nothing recognisable was found in the project. Add your own commands below.')
        return
      }
      setRows((all) => {
        const have = new Set(all.map((row) => row.name.toLowerCase()))
        const fresh = found.filter((step) => !have.has(step.name.toLowerCase())).map(fromStep)
        return [...all, ...fresh]
      })
      setSuggested(
        'Suggested from the project’s own files. Read them, change what you like, and save.',
      )
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!repoRoot) return
    setBusy(true)
    setError(null)
    try {
      await window.shokuba.checks.save({
        repoRoot,
        acknowledged,
        steps: rows.map((row) => ({
          kind: row.kind,
          name: row.name,
          command: row.command,
          timeoutSeconds: Math.min(
            MAX_TIMEOUT_SECONDS,
            Math.max(MIN_TIMEOUT_SECONDS, Math.round(row.minutes * 60)),
          ),
          enabled: row.enabled,
        })),
      })
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={ref}
      className="dialog dialog-wide"
      onClose={onClose}
      aria-labelledby="checks-title"
    >
      <form className="form" onSubmit={(event) => void submit(event)}>
        <h2 id="checks-title">Checks for {repoName}</h2>
        <p className="muted">
          Commands Shokuba runs on the work an agent submits, in the task’s own folder, so you can
          see whether it holds up. They are yours: kept in Shokuba, never read from the project, so
          an agent cannot add or weaken one. Setup steps (such as installing dependencies) run
          first.
        </p>

        <div className="checks-notice" role="note">
          <strong>Read this before switching checks on.</strong> They run automatically, on this
          computer, with your account’s access. The work they run was written by an agent, and{' '}
          <strong>this is not sandboxed</strong>: a test or an install script can do anything your
          account can. Only add commands you would be willing to run on code you have not read.
        </div>

        <ul className="check-rows">
          {rows.map((row, index) => (
            <li key={row.key} className="check-row">
              <div className="check-row-main">
                <select
                  value={row.kind}
                  onChange={(e) => update(row.key, { kind: e.target.value as CheckKind })}
                  aria-label="Kind"
                >
                  <option value="setup">Setup</option>
                  <option value="check">Check</option>
                </select>
                <input
                  value={row.name}
                  onChange={(e) => update(row.key, { name: e.target.value })}
                  placeholder="Name"
                  maxLength={60}
                  aria-label="Name"
                />
                <label className="check-enabled">
                  <input
                    type="checkbox"
                    checked={row.enabled}
                    onChange={(e) => update(row.key, { enabled: e.target.checked })}
                  />
                  <span>On</span>
                </label>
              </div>
              <input
                className="check-command"
                value={row.command}
                onChange={(e) => update(row.key, { command: e.target.value })}
                placeholder="Command, for example npm test"
                maxLength={1000}
                spellCheck={false}
                aria-label="Command"
              />
              <div className="check-row-foot">
                <label className="check-timeout">
                  <span>Stop after</span>
                  <input
                    type="number"
                    min={MIN_TIMEOUT_SECONDS / 60}
                    max={MAX_TIMEOUT_SECONDS / 60}
                    step={0.5}
                    value={row.minutes}
                    onChange={(e) => update(row.key, { minutes: Number(e.target.value) })}
                  />
                  <span>min</span>
                </label>
                <span className="spacer" />
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  aria-label="Move up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => move(index, 1)}
                  disabled={index === rows.length - 1}
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setRows((all) => all.filter((r) => r.key !== row.key))}
                  aria-label="Remove"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
        {rows.length === 0 && <p className="muted">No checks yet.</p>}

        <div className="row">
          <button
            type="button"
            className="btn"
            onClick={() => setRows((all) => [...all, blank('check')])}
            disabled={rows.length >= MAX_CHECK_STEPS}
          >
            + Add a step
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => void suggest()}>
            Suggest from the project’s files
          </button>
        </div>
        {suggested && <p className="muted">{suggested}</p>}

        <label className="check">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>
            I understand these run agent-written code, unsandboxed, with my account’s access, and I
            want them run automatically when an agent submits work for this project.
          </span>
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
            Save
          </button>
        </div>
      </form>
    </dialog>
  )
}
