import { useCallback, useEffect, useRef, useState } from 'react'
import type { PullOpenResult, PullPreview } from '@shared/github'
import { canOpen, openLabel, resultLine, willDo } from '../github/pull'
import { useGitHub } from '../store/github'

interface Props {
  open: boolean
  missionId: string
  onClose(): void
}

/**
 * Open a pull request for a mission. This is the one place Shokuba writes to GitHub, so it is done in
 * two steps: everything that would happen is shown first (who it is opened as, the branch and where
 * it goes, the commits, and the exact title and text), and only a click on the button carries out
 * that same thing. If anything changed in between, it is refused and shown again.
 */
export function PullRequestDialog({ open, missionId, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const pullPreview = useGitHub((s) => s.pullPreview)
  const pullOpen = useGitHub((s) => s.pullOpen)
  const [preview, setPreview] = useState<PullPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<PullOpenResult | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setPreview(null)
    const outcome = await pullPreview(missionId)
    setLoading(false)
    if (outcome.ok) setPreview(outcome.value)
    else setError(outcome.error)
  }, [pullPreview, missionId])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  // Each time it opens, look at where things stand now, and start again.
  useEffect(() => {
    if (!open) return
    setError(null)
    setDone(null)
    setDraft(true)
    void load()
  }, [open, load])

  async function confirm(): Promise<void> {
    if (!preview) return
    setBusy(true)
    setError(null)
    const outcome = await pullOpen(missionId, preview.hash, draft)
    setBusy(false)
    if (outcome.ok) {
      setDone(outcome.value)
      return
    }
    setError(outcome.error)
    // Whatever changed, show it again, so the next click is on what is true now.
    await load()
  }

  return (
    <dialog
      ref={dialogRef}
      className="dialog dialog-wide pull-dialog"
      onClose={onClose}
      aria-labelledby="pull-title"
    >
      <div className="form">
        <h2 id="pull-title">Open a pull request</h2>

        {loading && <p className="muted">Looking at the branch and at GitHub…</p>}

        {done ? (
          <>
            <p className="gh-status" data-tone="good" role="status">
              {resultLine(done)}
            </p>
            <p className="mono">{done.url}</p>
            <p className="muted">
              Nothing was merged, and nothing was written to the issue. The pull request is yours to
              review on GitHub.
            </p>
          </>
        ) : (
          preview && (
            <>
              <p className="muted">
                Nothing has been sent. This is exactly what will be done if you press the button. If
                anything changes before then, Shokuba refuses and shows it again.
              </p>
              <dl className="pull-facts">
                <dt>As</dt>
                <dd>{preview.login}</dd>
                <dt>Repository</dt>
                <dd>{preview.repo}</dd>
                <dt>Branch</dt>
                <dd className="mono">{preview.branch}</dd>
                <dt>Goes into</dt>
                <dd className="mono">{preview.base}</dd>
                <dt>Commits</dt>
                <dd>
                  {preview.commitCount}
                  <ul className="pull-commits">
                    {preview.commits.map((commit) => (
                      <li key={commit.id}>
                        <span className="mono">{commit.id}</span> {commit.subject}
                      </li>
                    ))}
                  </ul>
                </dd>
              </dl>

              {preview.problems.length > 0 && (
                <ul className="pull-problems" role="alert">
                  {preview.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              )}
              {preview.warnings.length > 0 && (
                <ul className="pull-warnings">
                  {preview.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}

              <h3>Title</h3>
              <p className="pull-title-text">{preview.title}</p>
              <h3>Text</h3>
              <pre className="issue-text">{preview.body}</pre>
              <p className="muted">
                The title comes from the issue, and the text from what each task recorded. What the
                agents said is shown in blocks that GitHub will not turn into links or mentions.
              </p>

              {canOpen(preview) && !preview.existing && (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={draft}
                    onChange={(e) => setDraft(e.target.checked)}
                  />
                  <span>Open as a draft (recommended: no one has reviewed it on GitHub yet)</span>
                </label>
              )}
              {canOpen(preview) && <p className="muted">{willDo(preview, draft)}</p>}
            </>
          )
        )}

        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}

        <div className="dialog-actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {done ? 'Done' : 'Cancel'}
          </button>
          {!done && preview && canOpen(preview) && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || loading}
              onClick={() => void confirm()}
            >
              {busy ? 'Working…' : openLabel(preview)}
            </button>
          )}
        </div>
      </div>
    </dialog>
  )
}
