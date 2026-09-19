import type { AgentView } from '@shared/agents/view'
import { BREAKER_HELP, BREAKER_LABELS } from '../office/bubble'
import { useOffice } from '../store/office'

/**
 * What the circuit breaker is doing to a running agent, and why. Nothing is shown for an agent
 * that is normal, or that is not running (a restart gives it a clean slate).
 */
export function BreakerChip({ view }: { view: AgentView | undefined }) {
  if (!view || view.pid === null || view.breakerLevel === 'normal') return null
  const { breakerLevel: level, breakerReason: reason } = view
  return (
    <span className="breaker-chip" data-level={level} title={BREAKER_HELP[level]}>
      <span className="breaker-label">
        <span aria-hidden="true">⚠</span> {BREAKER_LABELS[level]}
      </span>
      {reason && <span className="breaker-why">{reason}</span>}
    </span>
  )
}

/** The controls a person has over the breaker: lift its restrictions, or pause an agent by hand. */
export function BreakerButtons({
  employeeId,
  view,
}: {
  employeeId: string
  view: AgentView | undefined
}) {
  const breakerAction = useOffice((s) => s.breakerAction)
  if (!view || view.pid === null) return null
  const level = view.breakerLevel
  return (
    <>
      {level !== 'normal' && (
        <button
          type="button"
          className="btn"
          title="Lift the circuit breaker's restrictions and let it carry on"
          onClick={() => void breakerAction(employeeId, 'reset')}
        >
          Reset
        </button>
      )}
      {level !== 'pause' && level !== 'stop' && (
        <button
          type="button"
          className="btn"
          title="Interrupt it and refuse every tool call until you reset it"
          onClick={() => void breakerAction(employeeId, 'pause')}
        >
          Pause
        </button>
      )}
    </>
  )
}
