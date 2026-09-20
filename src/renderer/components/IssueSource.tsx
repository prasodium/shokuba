import { useState } from 'react'
import type { GitHubLink } from '@shared/github'
import type { Mission } from '@shared/missions'
import { planningView } from '../github/planning'
import { useGitHub } from '../store/github'
import { useOffice } from '../store/office'

interface Props {
  link: GitHubLink
  mission: Mission
}

/**
 * Where a mission came from on GitHub: which issue, what it says, and (while the mission is still a
 * draft) handing it to a manager to plan. What an issue says was written by other people, so it is
 * shown as plain text and only ever read, never followed. An agent is not sent it: a manager reads
 * it through a read-only tool that marks it as untrusted.
 */
export function IssueSource({ link, mission }: Props) {
  const employees = useOffice((s) => s.employees)
  const askToPlan = useGitHub((s) => s.askToPlan)
  const takeBackPlan = useGitHub((s) => s.takeBackPlan)
  const [chosen, setChosen] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const view = planningView(mission, employees)
  const managerId =
    view.kind === 'ask'
      ? (view.managers.find((m) => m.id === chosen)?.id ?? view.managers[0]?.id)
      : undefined
  const managerName =
    view.kind === 'ask' ? view.managers.find((m) => m.id === managerId)?.name : undefined

  async function run(work: () => Promise<{ ok: boolean; error?: string }>): Promise<void> {
    setBusy(true)
    setError(null)
    const outcome = await work()
    setBusy(false)
    if (!outcome.ok) setError(outcome.error ?? 'That did not work')
  }

  return (
    <section className="issue-source" aria-label="GitHub issue">
      <p className="mission-source" role="note" title={link.issueUrl}>
        From GitHub issue #{link.issueNumber} in {link.repo}
      </p>

      <details className="issue-details">
        <summary>What the issue says</summary>
        <p className="muted">
          Written by other people. It is shown here as plain text, and Shokuba never follows it. A
          manager you ask to plan reads it through a read-only tool that marks it as untrusted.
        </p>
        <p>
          <strong>{link.issueTitle}</strong>
          {link.issueAuthor ? <span className="muted"> · by {link.issueAuthor}</span> : null}
        </p>
        <pre className="issue-text">{link.issueBody || '(The issue has no text.)'}</pre>
      </details>

      {view.kind === 'planning' && (
        <div className="issue-planning">
          <p className="mission-author" role="note">
            Handed to {view.managerName} to plan. They can add and remove tasks here until you run
            it. Nothing is sent to anyone yet.
          </p>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void run(() => takeBackPlan(mission.id))}
          >
            Take it back
          </button>
        </div>
      )}

      {view.kind === 'ask' && managerId && (
        <div className="issue-planning">
          <div className="row">
            {view.managers.length > 1 && (
              <select
                aria-label="Manager"
                value={managerId}
                onChange={(e) => setChosen(e.target.value)}
              >
                {view.managers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void run(() => askToPlan(mission.id, managerId))}
            >
              Ask {managerName} to plan
            </button>
          </div>
          <small className="muted">
            Sends them one message and lets them add tasks to this draft. Nothing runs until you
            press Run mission.
          </small>
        </div>
      )}

      {view.kind === 'no-manager' && (
        <small className="muted">Hire a manager to have someone plan this from the issue.</small>
      )}

      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
    </section>
  )
}
