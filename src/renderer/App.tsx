import { useEffect, useState } from 'react'
import type { Employee } from '@shared/employees'
import { AboutDialog } from './components/AboutDialog'
import { DepartmentsDialog } from './components/DepartmentsDialog'
import { EmployeeDialog } from './components/EmployeeDialog'
import { EventDock } from './components/EventDock'
import { MessagesPanel } from './components/MessagesPanel'
import { MissionsPanel } from './components/MissionsPanel'
import { OfficeDialog } from './components/OfficeDialog'
import { OfficeView } from './components/OfficeView'
import { ReplayBar } from './components/ReplayBar'
import { ReplayLock } from './components/ReplayLock'
import { Roster } from './components/Roster'
import { RolesDialog } from './components/RolesDialog'
import { TerminalSection } from './components/TerminalSection'
import { versionPill } from './lib/about'
import { attentionCount } from './messages/helpers'
import { useMessages } from './store/messages'
import { useMissions } from './store/missions'
import { useOffice } from './store/office'
import { useReplaying } from './store/timeline'

export function App() {
  const connect = useOffice((s) => s.connect)
  const info = useOffice((s) => s.info)
  const notice = useOffice((s) => s.notice)
  const dismissNotice = useOffice((s) => s.dismissNotice)
  const replaying = useReplaying()

  const [dialog, setDialog] = useState<{ open: boolean; editing: Employee | null }>({
    open: false,
    editing: null,
  })

  const [rolesOpen, setRolesOpen] = useState(false)
  const [departmentsOpen, setDepartmentsOpen] = useState(false)
  const [officeOpen, setOfficeOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)

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
    <div className={replaying ? 'app is-replay' : 'app'}>
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
        <button
          type="button"
          className="version-pill"
          onClick={() => setAboutOpen(true)}
          title="About Shokuba, and what it found on this computer"
        >
          {info ? versionPill(info) : 'About'}
        </button>
      </header>

      {replaying && (
        <div className="replay-banner" role="status">
          <strong>Replay</strong>
          <span>
            You are watching what was recorded, not the live office. Nothing can be changed or sent
            until you go back to live.
          </span>
        </div>
      )}

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
            <OfficeView onNew={openNew} onCustomise={() => setOfficeOpen(true)} />
            <ReplayBar />
          </section>
          <Roster
            onNew={openNew}
            onEdit={openEdit}
            onRoles={() => setRolesOpen(true)}
            onDepartments={() => setDepartmentsOpen(true)}
          />
        </div>
        <div className="right">
          {replaying && (
            <p className="hint replay-present">
              These panels show the present, not the replayed moment, and are read only.
            </p>
          )}
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
          <ReplayLock>
            {tab === 'terminal' ? (
              <TerminalSection />
            ) : tab === 'missions' ? (
              <MissionsPanel />
            ) : (
              <MessagesPanel />
            )}
          </ReplayLock>
        </div>
      </main>

      <EventDock />
      <EmployeeDialog
        open={dialog.open}
        editing={dialog.editing}
        onClose={closeDialog}
        onEditRoles={() => setRolesOpen(true)}
        onEditDepartments={() => setDepartmentsOpen(true)}
      />
      <DepartmentsDialog open={departmentsOpen} onClose={() => setDepartmentsOpen(false)} />
      <OfficeDialog open={officeOpen} onClose={() => setOfficeOpen(false)} />
      <RolesDialog open={rolesOpen} onClose={() => setRolesOpen(false)} />
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </div>
  )
}
