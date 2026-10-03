import { useEffect, useRef, useState } from 'react'
import {
  PLATFORM_NAMES,
  gitFinding,
  githubFinding,
  loadAbout,
  providerFinding,
  type AboutFacts,
  type Finding,
} from '../lib/about'
import { useOffice } from '../store/office'
import { shokuba } from '../api'

interface Props {
  open: boolean
  onClose(): void
}

function Row({ finding }: { finding: Finding }) {
  return (
    <tr>
      <th scope="row">{finding.label}</th>
      <td className={finding.ok ? undefined : 'about-problem'}>
        {finding.ok ? '' : 'Problem: '}
        {finding.text}
      </td>
    </tr>
  )
}

function Failed({ label, error }: { label: string; error: string }) {
  return <Row finding={{ label, text: `Could not check: ${error}`, ok: false }} />
}

/**
 * Shokuba's version, what it runs on, and what it found on this computer. Read only: every line is
 * something detected when the dialog opened, never assumed.
 */
export function AboutDialog({ open, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const info = useOffice((s) => s.info)
  const [facts, setFacts] = useState<AboutFacts | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  // Check again each time it opens, so it says what is true now.
  useEffect(() => {
    if (!open) return
    let current = true
    setFacts(null)
    void loadAbout({
      git: () => shokuba.app.git(),
      github: () => shokuba.github.status(),
      providers: () => shokuba.providers.list(),
    }).then((loaded) => {
      if (current) setFacts(loaded)
    })
    return () => {
      current = false
    }
  }, [open])

  return (
    <dialog ref={dialogRef} className="dialog" onClose={onClose} aria-labelledby="about-title">
      <div className="form">
        <h2 id="about-title">About Shokuba</h2>
        <table className="about-table">
          <tbody>
            {info ? (
              <>
                <tr>
                  <th scope="row">Version</th>
                  <td>{info.version}</td>
                </tr>
                <tr>
                  <th scope="row">System</th>
                  <td>{PLATFORM_NAMES[info.platform]}</td>
                </tr>
                <tr>
                  <th scope="row">Electron</th>
                  <td>{info.electronVersion}</td>
                </tr>
                <tr>
                  <th scope="row">Node</th>
                  <td>{info.nodeVersion}</td>
                </tr>
              </>
            ) : (
              <tr>
                <td colSpan={2} className="muted">
                  Not connected to the main process.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <h3 className="about-heading">Found on this computer</h3>
        {facts === null ? (
          <p className="muted" role="status">
            Checking…
          </p>
        ) : (
          <table className="about-table">
            <tbody>
              {facts.git.ok ? (
                <Row finding={gitFinding(facts.git.value)} />
              ) : (
                <Failed label="Git" error={facts.git.error} />
              )}
              {facts.github.ok ? (
                <Row finding={githubFinding(facts.github.value)} />
              ) : (
                <Failed label="GitHub (gh)" error={facts.github.error} />
              )}
              {facts.providers.ok ? (
                facts.providers.value.map((provider) => (
                  <Row key={provider.id} finding={providerFinding(provider)} />
                ))
              ) : (
                <Failed label="Agent CLIs" error={facts.providers.error} />
              )}
            </tbody>
          </table>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </dialog>
  )
}
