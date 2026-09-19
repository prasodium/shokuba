import { useState } from 'react'
import type { EvidenceExportResult } from '@shared/evidence'
import { savedMessage } from '../evidence/summary'
import { errorMessage } from '../lib/errors'

interface Props {
  taskId: string
}

/**
 * Saves what Shokuba recorded about a task as a folder the person chooses. The app shows the
 * folder dialog; this page only asks for the export, and never says where it goes.
 */
export function TaskEvidenceView({ taskId }: Props) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<EvidenceExportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function save(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const saved = await window.shokuba.evidence.export(taskId)
      if (saved) setResult(saved) // null means the person cancelled the dialog
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="task-block">
      <h4>Evidence</h4>
      <p className="muted">
        A record of this task as a folder: what was asked, the changes, every run of the checks,
        every review and who accepted it. It is a record, not a proof, and it is not signed.
      </p>
      <div className="row">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Export the evidence pack…'}
        </button>
      </div>
      {result && (
        <>
          <p className="evidence-saved">{savedMessage(result)}</p>
          {result.warnings.length > 0 && (
            <ul className="evidence-warnings" aria-label="Before you share it">
              {result.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {error && <p className="field-error">{error}</p>}
    </div>
  )
}
