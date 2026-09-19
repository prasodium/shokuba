import { useEffect, useState } from 'react'
import type { Employee } from '@shared/employees'
import { EmployeeDialog } from './components/EmployeeDialog'
import { EventDock } from './components/EventDock'
import { MessagesPanel } from './components/MessagesPanel'
import { MissionsPanel } from './components/MissionsPanel'
import { OfficeView } from './components/OfficeView'
import { Roster } from './components/Roster'
import { TerminalSection } from './components/TerminalSection'
import { attentionCount } from './messages/helpers'
import { useMessages } from './store/messages'
import { useMissions } from './store/missions'
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

  const [tab, setTab] = useState<'terminal' | 'missions' | 'messages'>('terminal')
  // Unread messages to you, and conversations stopped as possible loops.
  const needsYou = useMessages((s) => attentionCount(s.conversations))
  // Work an agent has finished and is waiting for a person to accept.
  const awaitingReview = useMissions((s) =>
    s.missions.reduce(
      (count, m) => count + m.tasks.filter((t) => t.status === 'submitted').length,
      0,
    ),
  )

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
          Phase 2 · Missions
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
        <div className="right">
          <div className="tabs" role="tablist" aria-label="Terminal, missions and messages">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'terminal'}
              className="tab"
              onClick={() => setTab('terminal')}
            >
              Terminal
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'missions'}
              className="tab"
              onClick={() => setTab('missions')}
            >
              Missions
              {awaitingReview > 0 && (
                <span className="badge-count" title="Tasks waiting for your review">
                  {awaitingReview}
                </span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'messages'}
              className="tab"
              onClick={() => setTab('messages')}
            >
              Messages
              {needsYou > 0 && (
                <span
                  className="badge-count"
                  title="Unread messages, and conversations waiting for you"
                >
                  {needsYou}
                </span>
              )}
            </button>
          </div>
          {tab === 'terminal' ? (
            <TerminalSection />
          ) : tab === 'missions' ? (
            <MissionsPanel />
          ) : (
            <MessagesPanel />
          )}
        </div>
      </main>

      <EventDock />
      <EmployeeDialog open={dialog.open} editing={dialog.editing} onClose={closeDialog} />
    </div>
  )
}
