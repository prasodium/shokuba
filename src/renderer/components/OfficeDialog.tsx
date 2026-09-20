import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  DEFAULT_NAMES,
  DEFAULT_OFFICE_SETTINGS,
  FLOOR_TONES,
  MAX_NAME,
  MAX_OFFICE_NAME,
  NAME_KEYS,
  ROOM_KINDS,
  ROOM_KIND_LABELS,
  WALL_COLORS,
  type NameKey,
  type OfficeSettings,
} from '@shared/office'
import { THEMES, applyTheme, hasChanges, savable, themeOf } from '../office/settingsDraft'
import { useOfficeSettings } from '../store/officeSettings'

/** What each shared place is called in the form, for the person who does not know its key. */
const NAME_LABELS: Record<NameKey, string> = {
  managerCabin: 'Manager cabin',
  meetingRoom: 'Meeting room',
  readingRoom: 'Reading room',
  inbox: 'Your inbox',
  bench: 'QA bench',
  board: 'Mission board',
  tea: 'Tea corner',
  snacks: 'Snack corner',
}

interface Props {
  open: boolean
  onClose(): void
}

/**
 * Dress the office: its name, the floor of each kind of room, the walls, windows, plants and what the
 * shared places are called. The floor plan itself (where rooms, walls and desks are) is not
 * changed, so every choice leaves the office walkable.
 */
export function OfficeDialog({ open, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const saved = useOfficeSettings((s) => s.settings)
  const save = useOfficeSettings((s) => s.save)
  const [draft, setDraft] = useState<OfficeSettings>(saved)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const changed = hasChanges(draft, saved)
  const theme = themeOf(draft)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  // Each time it opens, start from how the office is dressed now.
  useEffect(() => {
    if (!open) return
    setError(null)
    setDraft(saved)
    // Only when it opens: a change made elsewhere must not throw away what is being edited.
  }, [open])

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const outcome = await save(savable(draft))
    setBusy(false)
    if (outcome.ok) setDraft(outcome.value)
    else setError(outcome.error)
  }

  function close(): void {
    if (changed && !window.confirm('Discard the changes you have made to the office?')) return
    onClose()
  }

  return (
    <dialog
      ref={dialogRef}
      className="dialog dialog-wide"
      onClose={onClose}
      aria-labelledby="office-title"
    >
      <form onSubmit={(event) => void submit(event)} className="form">
        <h2 id="office-title">Customise the office</h2>
        <p className="muted">
          Dress the office as you like. The floor plan stays as it is, so everyone can always get to
          every desk and every shared place.
        </p>

        <label className="field">
          <span>Name of the office (optional)</span>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            maxLength={MAX_OFFICE_NAME}
            placeholder="shown over the office"
          />
        </label>

        <fieldset className="field">
          <legend>Theme</legend>
          <div className="chips">
            {THEMES.map((t) => (
              <label key={t.id} className="chip-choice">
                <input
                  type="radio"
                  name="office-theme"
                  checked={theme?.id === t.id}
                  onChange={() => setDraft(applyTheme(draft, t))}
                  aria-label={t.label}
                />
                <span>{t.label}</span>
              </label>
            ))}
          </div>
          <small className="muted">
            A theme sets every floor and the walls at once. You can then change any of them.
          </small>
        </fieldset>

        <fieldset className="field">
          <legend>Floors</legend>
          <div className="office-floors">
            {ROOM_KINDS.map((kind) => {
              const tone = FLOOR_TONES.find((t) => t.id === draft.floors[kind]) ?? FLOOR_TONES[0]
              return (
                <label key={kind} className="office-floor">
                  <span>{ROOM_KIND_LABELS[kind]}</span>
                  <span className="office-floor-pick">
                    <span
                      className="office-floor-swatch"
                      style={{
                        background: `linear-gradient(135deg, ${tone.a} 50%, ${tone.b} 50%)`,
                      }}
                      aria-hidden="true"
                    />
                    <select
                      value={draft.floors[kind]}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          floors: {
                            ...draft.floors,
                            [kind]: e.target.value as OfficeSettings['floors'][typeof kind],
                          },
                        })
                      }
                    >
                      {FLOOR_TONES.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </span>
                </label>
              )
            })}
          </div>
        </fieldset>

        <fieldset className="field">
          <legend>Walls</legend>
          <div className="swatches">
            {WALL_COLORS.map((color) => (
              <label key={color.id} className="swatch-choice" title={color.label}>
                <input
                  type="radio"
                  name="office-wall"
                  value={color.id}
                  checked={draft.wall === color.id}
                  onChange={() => setDraft({ ...draft, wall: color.id })}
                  aria-label={color.label}
                />
                <span style={{ background: color.hex }} />
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="field">
          <legend>Decor</legend>
          <label className="check">
            <input
              type="checkbox"
              checked={draft.windows}
              onChange={(e) => setDraft({ ...draft, windows: e.target.checked })}
            />
            <span>Windows on the walls</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={draft.plants}
              onChange={(e) => setDraft({ ...draft, plants: e.target.checked })}
            />
            <span>Plants</span>
          </label>
        </fieldset>

        <fieldset className="field">
          <legend>What the places are called</legend>
          <div className="office-names">
            {NAME_KEYS.map((key) => (
              <label key={key} className="field">
                <span>{NAME_LABELS[key]}</span>
                <input
                  value={draft.names[key]}
                  onChange={(e) =>
                    setDraft({ ...draft, names: { ...draft.names, [key]: e.target.value } })
                  }
                  maxLength={MAX_NAME}
                  placeholder={DEFAULT_NAMES[key]}
                />
              </label>
            ))}
          </div>
          <small className="muted">Leave one empty to keep Shokuba’s name for it.</small>
        </fieldset>

        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}

        <div className="dialog-actions">
          <button
            type="button"
            className="btn"
            onClick={() => setDraft(DEFAULT_OFFICE_SETTINGS)}
            disabled={busy}
          >
            Back to the original look
          </button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={close}>
            Done
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !changed}>
            Save
          </button>
        </div>
      </form>
    </dialog>
  )
}
