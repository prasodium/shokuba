import { useEffect, useState } from 'react'
import type { Employee } from '@shared/employees'
import { EmployeeDialog } from './components/EmployeeDialog'
import { EventDock } from './components/EventDock'
import { OfficeView } from './components/OfficeView'
import { Roster } from './components/Roster'
import { TerminalSection } from './components/TerminalSection'
import { useOffice } from './store/office'

const PLATFORM_NAMES = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' } as const

export function App() {
  const connect = useOffice((s) => s.connect)
  const info = useOffice((s) => s.info)
  const notice = useOffice((s) => s.notice)
  const dismissNotice = useOffice((s) => s.dismissNotice)

  const [dialog, setDialog] = useState<{ open: boolean; editing: Employee | null }>({
    open: false,
    editing: null,
  })

  useEffect(() => connect(), [connect])

  const openNew = (): void => setDialog({ open: true, editing: null })
  const openEdit = (employee: Employee): void => setDialog({ open: true, editing: employee })
  const closeDialog = (): void => setDialog((current) => ({ ...current, open: false }))

  return (
    <div className="app">
      <header className="masthead">
        <div className="logo" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        <div>
          <h1>
            Shokuba <span className="kanji">職場</span>
          </h1>
          <p className="tagline">A Multi-Agent Harness</p>
        </div>
        <span className="phase">
          Phase 1 · First agent
          {info && ` · v${info.version} · ${PLATFORM_NAMES[info.platform]}`}
        </span>
      </header>

      {notice && (
        <div role="alert" className="notice">
          <span>{notice}</span>
          <button type="button" className="btn btn-ghost" onClick={dismissNotice}>
            Dismiss
          </button>
        </div>
      )}

      <main className="workspace">
        <div className="left">
          <section className="panel office-panel" aria-label="Office">
            <OfficeView onNew={openNew} />
          </section>
          <Roster onNew={openNew} onEdit={openEdit} />
        </div>
        <TerminalSection />
      </main>

      <EventDock />
      <EmployeeDialog open={dialog.open} editing={dialog.editing} onClose={closeDialog} />
    </div>
  )
}
