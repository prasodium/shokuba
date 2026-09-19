import { selectedEmployee, useOffice } from '../store/office'
import { BreakerButtons, BreakerChip } from './BreakerChip'
import { StatePill } from './StatePill'
import { TerminalPanel } from './TerminalPanel'

/** The terminal for the selected employee, with the controls that act on their process. */
export function TerminalSection() {
  const employee = useOffice(selectedEmployee)
  const view = useOffice((s) => (employee ? s.views[employee.id] : undefined))
  const providers = useOffice((s) => s.providers)
  const startAgent = useOffice((s) => s.startAgent)
  const stopAgent = useOffice((s) => s.stopAgent)
  const interruptAgent = useOffice((s) => s.interruptAgent)

  if (!employee) {
    return (
      <section className="panel terminal-section" aria-label="Terminal">
        <div className="panel-head">
          <h2>Terminal</h2>
        </div>
        <div className="empty">
          <p className="muted">Select an employee to see their terminal.</p>
        </div>
      </section>
    )
  }

  const running = view?.pid != null
  const provider = providers.find((p) => p.id === employee.providerId)
  const runKey = `${employee.id}:${view?.pid ?? 'none'}`

  return (
    <section className="panel terminal-section" aria-label={`Terminal for ${employee.name}`}>
      <div className="panel-head">
        <div className="terminal-title">
          <h2>{employee.name}</h2>
          <StatePill view={view} />
          <BreakerChip view={view} />
        </div>
        <div className="row">
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
              <button type="button" className="btn" onClick={() => void stopAgent(employee.id)}>
                Stop
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void startAgent(employee.id)}
            >
              Start
            </button>
          )}
        </div>
      </div>

      {view?.state === 'starting' && (
        <p className="hint">
          Waiting for {provider?.displayName ?? 'the agent'} to report in. If it is showing a setup
          or login screen, finish it in the terminal below.
        </p>
      )}
      {!running && view?.state === 'error' && view.error && (
        <p className="hint hint-error">{view.error}</p>
      )}
      {provider && !provider.installation.found && !running && (
        <p className="hint hint-error">{provider.installation.problem}</p>
      )}

      <TerminalPanel employeeId={employee.id} runKey={runKey} running={running} />
    </section>
  )
}
