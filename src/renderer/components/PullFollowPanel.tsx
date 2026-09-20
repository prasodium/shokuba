import { useCallback, useEffect, useState } from 'react'
import type { PullFollowUpRequest, PullStatus } from '@shared/github'
import {
  REFRESH_MS,
  checkedLine,
  checksLine,
  followUpNote,
  isWatching,
  stateLine,
} from '../github/follow'
import { useGitHub } from '../store/github'

interface Props {
  missionId: string
}

/**
 * Where the pull request Shokuba opened stands on GitHub: whether it is open, its checks, and who has
 * asked for changes. It only reads GitHub, about once a minute while it is on screen and open. A failing
 * check or a request for changes can be made into a task with one click; the task is Shokuba's own
 * words, and what GitHub said is kept apart and read by an agent only through a read-only tool.
 * Names here are shown as plain text: a check's name was written by whoever set the repository up.
 */
export function PullFollowPanel({ missionId }: Props) {
  const pullStatus = useGitHub((s) => s.pullStatus)
  const pullFollowUp = useGitHub((s) => s.pullFollowUp)
  const [status, setStatus] = useState<PullStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const outcome = await pullStatus(missionId)
    if (outcome.ok) {
      setStatus(outcome.value)
      setError(null)
    } else {
      setError(outcome.error)
    }
  }, [pullStatus, missionId])

  useEffect(() => {
    void load()
  }, [load])

  const watching = isWatching(status)
  useEffect(() => {
    if (!watching) return
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [watching, load])

  async function makeTask(request: PullFollowUpRequest): Promise<void> {
    setBusy(true)
    setError(null)
    setNote(null)
    const outcome = await pullFollowUp(request)
    setBusy(false)
    if (outcome.ok) setNote(followUpNote(outcome.value))
    else setError(outcome.error)
    await load()
  }

  const open = status?.state === 'open'
  const trouble = status ? status.checks.items.filter((item) => item.state !== 'passed') : []

  return (
    <div className="pull-follow" aria-label="The pull request on GitHub">
      {status ? (
        <p className="pull-follow-head">
          <strong>{stateLine(status)}</strong>
          {open && <> · {checksLine(status.checks)}</>}
          {open && status.approvedBy.length > 0 && (
            <> · approved by {status.approvedBy.join(', ')}</>
          )}
        </p>
      ) : (
        !error && <p className="muted">Looking at the pull request on GitHub…</p>
      )}

      {open && (trouble.length > 0 || status.changesRequested.length > 0) && (
        <ul className="pull-follow-list">
          {trouble.map((item) => (
            <li key={item.ref}>
              <span className="pull-follow-name">{item.name}</span>
              <span className="muted">{item.state === 'failed' ? 'failing' : 'still running'}</span>
              {item.state === 'failed' && (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void makeTask({ missionId, kind: 'check', ref: item.ref })}
                >
                  Make a task
                </button>
              )}
            </li>
          ))}
          {status.changesRequested.map((asked) => (
            <li key={asked.ref}>
              <span className="pull-follow-name">Changes requested by {asked.author}</span>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void makeTask({ missionId, kind: 'review', ref: asked.ref })}
              >
                Make a task
              </button>
            </li>
          ))}
        </ul>
      )}

      {note && (
        <p className="mission-author" role="status">
          {note}
        </p>
      )}
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      <div className="row">
        <button type="button" className="btn btn-ghost" onClick={() => void load()}>
          Check again
        </button>
        {status && <small className="muted">{checkedLine(status.checkedAt)}</small>}
      </div>
    </div>
  )
}
