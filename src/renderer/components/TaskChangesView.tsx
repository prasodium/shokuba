import { useEffect, useState } from 'react'
import type { TaskChanges } from '@shared/git'
import { classifyDiff, fileCounts, summarizeChanges } from '../git/diff'
import { latestWorkspaceSeq } from '../git/events'
import { useEvents } from '../store/events'

/** A phrase as the start of a sentence. */
const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

interface Props {
  taskId: string
  /** The assignee's name, for saying whose folder a task ran in when it was not isolated. */
  assignee: string | null
  /** Changes whenever the task moves, so what is shown is read again. */
  version: string
}

/**
 * What a task changed in its own Git branch, for review, or why it has no branch. The diff is
 * shown as plain text: nothing in a file can become part of the page.
 */
export function TaskChangesView({ taskId, assignee, version }: Props) {
  const [changes, setChanges] = useState<TaskChanges | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [showDiff, setShowDiff] = useState(false)
  // Read again whenever this task's folder is made, saved, merged or removed.
  const workspaceSeq = useEvents((s) => latestWorkspaceSeq(s.events, { taskId }))

  useEffect(() => {
    let current = true
    setProblem(null)
    window.shokuba.tasks
      .changes(taskId)
      .then((result) => {
        if (current) setChanges(result)
      })
      .catch(() => {
        if (current) setProblem('The changes could not be read.')
      })
    return () => {
      current = false
    }
  }, [taskId, version, workspaceSeq])

  if (problem) return <p className="muted">{problem}</p>
  if (!changes) return null
  // Not handed out yet: nothing to say.
  if (!changes.isolated && changes.reason === null) return null

  if (!changes.isolated) {
    return (
      <div className="task-block">
        <h4>Changes</h4>
        <p className="muted">
          Not isolated: {changes.reason}. This task ran in {assignee ? `${assignee}’s` : 'its'} own
          folder, so there is no separate branch or diff to show.
        </p>
      </div>
    )
  }

  const lines = classifyDiff(changes.diff)
  return (
    <div className="task-block">
      <h4>Changes</h4>
      <p className="muted">
        In its own Git branch <code>{changes.branch}</code>
        {changes.state === 'merged'
          ? ', and accepted into the mission branch.'
          : '. Nothing reaches your project until you accept it.'}{' '}
        {sentence(summarizeChanges(changes.files))}.
        {changes.folderRemoved &&
          ' Its working folder has been removed; the work stays on the branch.'}
      </p>
      {changes.note && <p className="field-error">{changes.note}</p>}
      {changes.files.length > 0 && (
        <ul className="changed-files">
          {changes.files.map((file) => (
            <li key={file.path}>
              <span className="changed-path">{file.path}</span>
              <span className="changed-counts">{fileCounts(file)}</span>
            </li>
          ))}
        </ul>
      )}
      {lines.length > 0 && (
        <>
          <button type="button" className="btn btn-ghost" onClick={() => setShowDiff((v) => !v)}>
            {showDiff ? 'Hide the diff' : 'Show the diff'}
          </button>
          {showDiff && (
            <pre className="diff" aria-label="Diff">
              {lines.map((line, index) => (
                <span key={index} className={`diff-line diff-${line.kind}`}>
                  {line.text}
                </span>
              ))}
            </pre>
          )}
          {showDiff && changes.truncated && (
            <p className="muted">The diff is long, so only the start is shown.</p>
          )}
        </>
      )}
    </div>
  )
}
