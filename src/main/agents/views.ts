import { applyEvent, initialView, type AgentView } from '@shared/agents/view'
import type { AgentSnapshot } from '@shared/ipc/api'
import type { EventBus } from '../events/bus'

/**
 * The main process's copy of every agent's `AgentView`, kept by folding the event stream
 * through the same reducer the renderer uses. It exists so a freshly opened (or reloaded)
 * window can be handed the present state without replaying history.
 */
export class AgentViews {
  private readonly views = new Map<string, AgentView>()
  private lastSeq: number
  private readonly unsubscribe: () => void

  constructor(
    bus: EventBus,
    startSeq: number,
    existingEmployeeIds: readonly string[],
    private readonly now: () => Date = () => new Date(),
  ) {
    this.lastSeq = startSeq
    for (const id of existingEmployeeIds) this.ensure(id)

    this.unsubscribe = bus.onAny((event) => {
      this.lastSeq = event.seq
      // A new employee gets a view straight away, so nothing they do can be missed.
      if (event.type === 'agent.created') this.ensure(event.payload.employeeId, event.ts)
      for (const [id, view] of this.views) {
        const next = applyEvent(view, event)
        if (next !== view) this.views.set(id, next)
      }
    })
  }

  snapshot(employeeIds: readonly string[]): AgentSnapshot {
    return {
      views: employeeIds.map((id) => this.ensure(id)),
      lastSeq: this.lastSeq,
    }
  }

  dispose(): void {
    this.unsubscribe()
  }

  private ensure(id: string, ts = this.now().toISOString()): AgentView {
    const existing = this.views.get(id)
    if (existing) return existing
    const view = initialView(id, ts)
    this.views.set(id, view)
    return view
  }
}
