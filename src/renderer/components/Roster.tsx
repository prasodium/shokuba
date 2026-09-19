import type { Employee } from '@shared/employees'
import { orderTeam } from '../lib/team'
import { useMissions } from '../store/missions'
import { useOffice } from '../store/office'
import { BreakerButtons, BreakerChip } from './BreakerChip'
import { StatePill } from './StatePill'

function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

interface Props {
  onNew(): void
  onEdit(employee: Employee): void
}

export function Roster({ onNew, onEdit }: Props) {
  const employees = useOffice((s) => s.employees)
  const views = useOffice((s) => s.views)
  const providers = useOffice((s) => s.providers)
  const selectedId = useOffice((s) => s.selectedId)
  const select = useOffice((s) => s.select)
  const startAgent = useOffice((s) => s.startAgent)
  const stopAgent = useOffice((s) => s.stopAgent)
  const interruptAgent = useOffice((s) => s.interruptAgent)
  const missions = useMissions((s) => s.missions)
  const allTasks = missions.flatMap((m) => m.tasks)

  return (
    <section className="panel roster" aria-label="Employees">
      <div className="panel-head">
        <h2>Employees</h2>
        <button type="button" className="btn btn-primary" onClick={onNew}>
          + New employee
        </button>
      </div>

      {employees.length === 0 ? (
        <div className="empty">
          <p>
            <strong>No one works here yet.</strong>
          </p>
          <p className="muted">
            Hire an employee, pick the folder they work in, and start them. You can begin with the
            simulated demo agent — it needs no AI account.
          </p>
        </div>
      ) : (
        <ul className="cards">
          {orderTeam(employees).map(({ employee, manager }) => {
            const view = views[employee.id]
            const running = view?.pid != null
            const provider = providers.find((p) => p.id === employee.providerId)
            return (
              <li
                key={employee.id}
                className={`card ${employee.id === selectedId ? 'is-selected' : ''} ${manager ? 'is-report' : ''}`}
                aria-current={employee.id === selectedId}
              >
                <button
                  type="button"
                  className="card-main"
                  onClick={() => select(employee.id)}
                  aria-label={`Select ${employee.name}`}
                >
                  <span
                    className="swatch"
                    style={{ background: employee.color }}
                    aria-hidden="true"
                  />
                  <span className="card-text">
                    <span className="card-title">
                      {employee.name} <span className="muted">· {employee.role}</span>
                      {employee.isManager && <span className="tag-manager">Manager</span>}
                    </span>
                    <span className="card-sub" title={employee.workingDirectory}>
                      {provider?.displayName ?? employee.providerId} ·{' '}
                      {folderName(employee.workingDirectory)}
                    </span>
                    {manager && (
                      <span
                        className="card-sub"
                        title="Asks their manager rather than messaging you"
                      >
                        reports to {manager.name}
                      </span>
                    )}
                    {(() => {
                      const working = allTasks.find(
                        (t) => t.assigneeId === employee.id && t.status === 'in_progress',
                      )
                      return working ? <span className="card-task">▸ {working.title}</span> : null
                    })()}
                    <BreakerChip view={view} />
                  </span>
                  <StatePill view={view} />
                </button>
                <div className="card-actions">
                  {running ? (
                    <>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void interruptAgent(employee.id)}
                      >
                        Interrupt
                      </button>
                      <BreakerButtons employeeId={employee.id} view={view} />
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void stopAgent(employee.id)}
                      >
                        Stop
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => {
                        select(employee.id)
                        void startAgent(employee.id)
                      }}
                    >
                      Start
                    </button>
                  )}
                  <button type="button" className="btn btn-ghost" onClick={() => onEdit(employee)}>
                    Edit
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
