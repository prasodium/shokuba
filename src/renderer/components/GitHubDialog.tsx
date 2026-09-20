import { useEffect, useRef, useState } from 'react'
import { importedAs, issueMeta, statusLine } from '../github/status'
import { useGitHub } from '../store/github'
import type { IssueState } from '../store/githubStore'
import { useMissions } from '../store/missions'

const STATE_LABELS: Record<IssueState, string> = {
  open: 'Open issues',
  closed: 'Closed issues',
  all: 'All issues',
}

interface Props {
  open: boolean
  onClose(): void
}

/**
 * Make a mission from a GitHub issue. Shokuba reads GitHub through the `gh` tool the person is
 * already signed in with, so there is nothing to paste and nothing to trust it with. This only
 * reads: nothing here writes to GitHub. What issues say was written by other people, so it is
 * shown as plain text and only ever kept with the mission, never followed.
 */
export function GitHubDialog({ open, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const { status, projects, issues, loading, error, links, check, loadIssues, importIssue } =
    useGitHub()
  const [repoRoot, setRepoRoot] = useState('')
  const [state, setState] = useState<IssueState>('open')
  /** The issue being made into a mission right now. */
  const [making, setMaking] = useState<number | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const line = statusLine(status)
  const project = projects.find((p) => p.repoRoot === repoRoot)
  const ready = status?.state === 'ready'

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  // Each time it opens, find out whether GitHub can be used, and start again.
  useEffect(() => {
    if (!open) return
    setFailure(null)
    setMaking(null)
    void check()
  }, [open, check])

  // Once the projects are known, start on the first (or keep the one already chosen).
  useEffect(() => {
    if (!open || projects.length === 0 || projects.some((p) => p.repoRoot === repoRoot)) return
    setRepoRoot(projects[0]?.repoRoot ?? '')
  }, [open, projects, repoRoot])

  useEffect(() => {
    if (open && ready && project) void loadIssues(project.repoRoot, state)
  }, [open, ready, project, state, loadIssues])

  async function make(number: number): Promise<void> {
    if (!project) return
    setMaking(number)
    setFailure(null)
    const outcome = await importIssue(project.repoRoot, number)
    setMaking(null)
    if (!outcome.ok) {
      setFailure(outcome.error)
      return
    }
    // Show the new mission straight away.
    await useMissions.getState().refresh()
    useMissions.getState().selectMission(outcome.value.missionId)
    onClose()
  }

  function show(missionId: string): void {
    useMissions.getState().selectMission(missionId)
    onClose()
  }

  const now = Date.now()

  return (
    <dialog
      ref={dialogRef}
      className="dialog dialog-wide"
      onClose={onClose}
      aria-labelledby="github-title"
    >
      <div className="form">
        <h2 id="github-title">Import from GitHub</h2>
        <p className="muted">
          Pick an issue to make a mission from. Shokuba only reads GitHub, through the GitHub tool (
          <span className="mono">gh</span>) you are already signed in with. It never sees your
          login, and nothing is written to GitHub. What an issue says was written by other people,
          so it is shown as plain text and never treated as an instruction.
        </p>

        <p className="gh-status" data-tone={line.tone} role="status">
          {line.text}
        </p>
        {line.hint && <p className="muted">{line.hint}</p>}

        {ready && projects.length === 0 && !error && (
          <p className="muted">
            None of your employees work in a project that is on GitHub. Hire someone in a folder
            whose <span className="mono">origin</span> remote is on github.com.
          </p>
        )}

        {ready && projects.length > 0 && (
          <div className="row gh-pickers">
            <label className="field">
              <span>Project</span>
              <select value={repoRoot} onChange={(e) => setRepoRoot(e.target.value)}>
                {projects.map((p) => (
                  <option key={p.repoRoot} value={p.repoRoot}>
                    {p.repo} ({p.name})
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Show</span>
              <select value={state} onChange={(e) => setState(e.target.value as IssueState)}>
                {(Object.keys(STATE_LABELS) as IssueState[]).map((key) => (
                  <option key={key} value={key}>
                    {STATE_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {(error || failure) && (
          <p role="alert" className="field-error">
            {failure ?? error}
          </p>
        )}

        {ready && project && (
          <>
            {loading && <p className="muted">Reading issues…</p>}
            {!loading && !error && issues.length === 0 && (
              <p className="muted">
                No {state === 'all' ? '' : `${state} `}issues in {project.repo}.
              </p>
            )}
            <ul className="gh-issues" aria-label="Issues">
              {issues.map((issue) => {
                const existing = importedAs(links, project.repo, issue.number)
                return (
                  <li key={issue.number} className="gh-issue">
                    <div className="gh-issue-text">
                      <strong>
                        #{issue.number} {issue.title}
                      </strong>
                      {issue.labels.length > 0 && (
                        <span className="gh-labels">
                          {issue.labels.map((label) => (
                            <small key={label} className="gh-label">
                              {label}
                            </small>
                          ))}
                        </span>
                      )}
                      <span className="muted">
                        {issue.state === 'closed' ? 'closed · ' : ''}
                        {issueMeta(issue, now)}
                      </span>
                    </div>
                    {existing ? (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => show(existing.missionId)}
                      >
                        Open mission
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={making !== null}
                        onClick={() => void make(issue.number)}
                      >
                        {making === issue.number ? 'Making…' : 'Make a mission'}
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          </>
        )}

        <div className="dialog-actions">
          {status && status.state !== 'ready' && (
            <button type="button" className="btn" onClick={() => void check()}>
              Check again
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  )
}
