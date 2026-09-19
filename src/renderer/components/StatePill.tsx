import type { AgentView } from '@shared/agents/view'
import { STATE_LABELS, provenance } from '../office/bubble'

/** An employee's runtime state, with a note when it is our inference or demo data. */
export function StatePill({ view }: { view: AgentView | undefined }) {
  const state = view?.state ?? 'offline'
  const how = view ? provenance(view.stateSource) : null
  return (
    <span className="pill" data-state={state} title={view?.reason ?? undefined}>
      <span className="pill-dot" aria-hidden="true" />
      {STATE_LABELS[state]}
      {how && <span className="pill-how">{how}</span>}
    </span>
  )
}
