import { applyEvent, initialView, type AgentView } from '@shared/agents/view'
import type { ShokubaEvent } from '@shared/events/schema'

export interface AgentsState {
  views: Record<string, AgentView>
  /** Highest event seq already folded in; older or equal events are ignored. */
  lastSeq: number
}

/**
 * Fold one live event into the agents' views. Idempotent by `seq`, so the overlap between
 * a snapshot and the live stream (or a duplicate delivery) is harmless. Keeps object
 * identity for views that did not change so React can skip them.
 */
export function foldEvent(state: AgentsState, event: ShokubaEvent): AgentsState {
  if (event.seq <= state.lastSeq) return state

  let views = state.views
  const set = (id: string, view: AgentView): void => {
    if (views === state.views) views = { ...state.views }
    views[id] = view
  }

  if (event.type === 'agent.created' && !views[event.payload.employeeId]) {
    set(event.payload.employeeId, initialView(event.payload.employeeId, event.ts))
  }

  for (const [id, view] of Object.entries(views)) {
    const next = applyEvent(view, event)
    if (next !== view) set(id, next)
  }

  if (event.type === 'employee.updated' && event.payload.fields.includes('archived')) {
    if (views[event.payload.employeeId]) {
      if (views === state.views) views = { ...state.views }
      delete views[event.payload.employeeId]
    }
  }

  return { views, lastSeq: event.seq }
}

/** Fold several events in seq order. */
export function foldEvents(state: AgentsState, events: readonly ShokubaEvent[]): AgentsState {
  return [...events].sort((a, b) => a.seq - b.seq).reduce(foldEvent, state)
}
