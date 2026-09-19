import { useEffect, useState } from 'react'
import type { TaskVerification } from '@shared/verification'
import { errorMessage } from '../lib/errors'
import { latestVerificationSeq } from '../git/events'
import {
  canRunAgain,
  durationText,
  runHeadline,
  runTone,
  STEP_LABELS,
} from '../verification/summary'
import { useEvents } from '../store/events'
import { ChecksDialog } from './ChecksDialog'

interface Props {
  taskId: string
  /** The task's status, for whether the checks can be run again by hand. */
  status: string
  /** Changes when the task moves, so what is shown is read again. */
  version: string
}

/**
 * What Shokuba's checks found on a task's work: the commands the person set up, run on the exact
 * commit the agent submitted. It reports what the commands did; whether the work is good is the
 * person's call.
 */
export function TaskVerificationView({ taskId, status, version }: Props) {
  const [verification, setVerification] = useState<TaskVerification | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [setUp, setSetUp] = useState(false)
  const seq = useEvents((s) => latestVerificationSeq(s.events, taskId))

  useEffect(() => {
    let current = true
    window.shokuba.checks
      .forTask(taskId)
      .then((result) => current && setVerification(result))
      .catch((e: unknown) => current && setError(errorMessage(e)))
    return () => {
      current = false
    }
  }, [taskId, version, seq, setUp])

  if (error) return <p className="field-error">{error}</p>
  if (!verification) return null
  // Not handed out yet, or worked on outside a project: nothing to show unless there is a reason.
  if (verification.repoRoot === null && verification.reason === null) return null

  const run = verification.latest

  async function again(): Promise<void> {
    setError(null)
    try {
      await window.shokuba.checks.run(taskId)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <div className="task-block">
      <h4>Checks</h4>

      {verification.repoRoot === null ? (
        <p className="muted">{verification.reason}</p>
      ) : (
        <>
          {run ? (
            <p className={`verdict verdict-${runTone(run)}`}>
              {runHeadline(run)}
              <span className="muted">
                {' '}
                · on commit {run.commit ? run.commit.slice(0, 8) : 'none'}
                {run.trigger === 'manual' ? ' · run by you' : ''}
              </span>
            </p>
          ) : (
            <p className="muted">
              {verification.configured
                ? 'Checks will run when the agent submits its work.'
                : verification.reason}
            </p>
          )}

          {run && run.results.length > 0 && (
            <ul className="check-results">
              {run.results.map((result) => (
                <li key={result.position}>
                  <button
                    type="button"
                    className="check-result"
                    data-state={result.state}
                    onClick={() =>
                      setOpen(
                        open === `${run.id}:${result.position}`
                          ? null
                          : `${run.id}:${result.position}`,
                      )
                    }
                    aria-expanded={open === `${run.id}:${result.position}`}
                  >
                    <span className="check-state">{STEP_LABELS[result.state]}</span>
                    <span className="check-name">
                      {result.name}
                      {result.kind === 'setup' && <span className="muted"> (setup)</span>}
                    </span>
                    <span className="muted">{durationText(result.durationMs)}</span>
                  </button>
                  {open === `${run.id}:${result.position}` && (
                    <div className="check-detail">
                      <p className="muted">
                        <code>{result.command}</code>
                        {result.exitCode !== null ? ` · exit code ${result.exitCode}` : ''}
                      </p>
                      <pre className="check-output" aria-label={`Output of ${result.name}`}>
                        {result.output || '(no output)'}
                      </pre>
                      {result.truncated && (
                        <p className="muted">Long output: only the end is kept.</p>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="row">
            {canRunAgain(verification, status) && (
              <button type="button" className="btn btn-ghost" onClick={() => void again()}>
                Run the checks again
              </button>
            )}
            <button type="button" className="btn btn-ghost" onClick={() => setSetUp(true)}>
              {verification.configured ? 'Edit the checks' : 'Set up checks…'}
            </button>
          </div>
          <p className="muted">
            The checks are commands you set up; they run on agent-written code, unsandboxed.
          </p>
          <ChecksDialog
            open={setUp}
            repoRoot={verification.repoRoot}
            repoName={verification.repoName ?? 'this project'}
            onClose={() => setSetUp(false)}
          />
        </>
      )}
    </div>
  )
}
