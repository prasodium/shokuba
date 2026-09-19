import type { EventSource, ShokubaEvent } from '../events/schema'
import type { RuntimeState } from '../types/agent'

/**
 * What the UI knows about one agent right now, derived purely from events.
 *
 * Main and renderer both fold the same event stream through `applyEvent`, so the
 * office, the roster and any later replay cannot disagree about what an agent is doing.
 */
export interface AgentView {
  employeeId: string
  state: RuntimeState
  /** How we know `state`: told by the agent (reported), deduced (inferred), or demo data. */
  stateSource: EventSource
  /** Why the last transition happened, if the emitter said. */
  reason: string | null
  /** ISO timestamp of the last state change. */
  since: string
  pid: number | null
  /** The tool the agent is using right now, or null. */
  activity: { toolName: string; summary: string } | null
  error: string | null
}

export function initialView(employeeId: string, ts: string): AgentView {
  return {
    employeeId,
    state: 'offline',
    stateSource: 'system',
    reason: null,
    since: ts,
    pid: null,
    activity: null,
    error: null,
  }
}

/**
 * Fold one event into a view. Returns the *same object* when the event does not concern
 * this agent, so callers can cheaply skip re-rendering. Callers own de-duplication by `seq`.
 */
export function applyEvent(view: AgentView, event: ShokubaEvent): AgentView {
  switch (event.type) {
    case 'agent.started':
      if (event.payload.employeeId !== view.employeeId) return view
      return { ...view, pid: event.payload.pid ?? null, error: null }

    case 'agent.state.changed': {
      if (event.payload.employeeId !== view.employeeId) return view
      const to = event.payload.to
      const working =
        to === 'thinking' || to === 'coding' || to === 'testing' || to === 'researching'
      return {
        ...view,
        state: to,
        stateSource: event.source,
        reason: event.payload.reason ?? null,
        since: event.ts,
        // A finished or stopped agent has no current tool.
        activity: working || to === 'reviewing' ? view.activity : null,
        error: to === 'error' ? view.error : null,
      }
    }

    case 'agent.tool.started':
      if (event.payload.employeeId !== view.employeeId) return view
      return {
        ...view,
        activity: { toolName: event.payload.toolName, summary: event.payload.summary },
      }

    case 'agent.tool.finished':
      if (event.payload.employeeId !== view.employeeId) return view
      return { ...view, activity: null }

    case 'agent.error':
      if (event.payload.employeeId !== view.employeeId) return view
      return { ...view, error: event.payload.message }

    case 'agent.stopped':
      if (event.payload.employeeId !== view.employeeId) return view
      return { ...view, pid: null, activity: null }

    default:
      return view
  }
}

/** Build views from scratch for known employees, folding in any events (already ordered). */
export function buildViews(
  employeeIds: readonly string[],
  events: readonly ShokubaEvent[],
  now: string,
): Map<string, AgentView> {
  const views = new Map(employeeIds.map((id) => [id, initialView(id, now)]))
  for (const event of events) {
    for (const [id, view] of views) views.set(id, applyEvent(view, event))
  }
  return views
}
