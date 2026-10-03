import { initialView, type AgentView } from '@shared/agents/view'
import type { ShokubaEvent } from '@shared/events/schema'
import { foldEvent, type AgentsState } from '../store/fold'

/** What replay shows at one moment, rebuilt from recorded events and nothing else. */
export interface ReplayState {
  agents: AgentsState
  /**
   * Who each task had last been handed to, as recorded. A flight in replay asks this, never today's
   * missions, so it cannot show work going to someone it went to later.
   */
  assignees: Readonly<Record<string, string>>
}

export const EMPTY_REPLAY: ReplayState = { agents: { views: {}, lastSeq: 0 }, assignees: {} }

/**
 * Fold one event into the replay state, through the same reducer the live window uses. The one
 * addition is a restart: when the app starts, the main process gives every employee a fresh view,
 * so replay does the same, and an agent that was working when the app last closed does not appear
 * to carry on working after it.
 */
export function foldReplay(state: ReplayState, event: ShokubaEvent): ReplayState {
  let agents = state.agents
  if (event.type === 'app.started' && event.seq > agents.lastSeq) {
    const views: Record<string, AgentView> = {}
    for (const id of Object.keys(agents.views)) views[id] = initialView(id, event.ts)
    agents = { views, lastSeq: agents.lastSeq }
  }
  agents = foldEvent(agents, event)

  let assignees = state.assignees
  if (event.type === 'task.dispatched' || event.type === 'task.assigned') {
    const { taskId, employeeId } = event.payload
    if (employeeId !== null && assignees[taskId] !== employeeId) {
      assignees = { ...assignees, [taskId]: employeeId }
    } else if (employeeId === null && taskId in assignees) {
      const rest = { ...assignees }
      delete rest[taskId]
      assignees = rest
    }
  }

  return agents === state.agents && assignees === state.assignees ? state : { agents, assignees }
}

/**
 * The whole log, and the state at any point in it. Moving forward folds only the new events; moving
 * back starts again from the nearest checkpoint, one every `checkpointEvery` events.
 */
export class ReplayHistory {
  private readonly checkpoints: ReplayState[] = [EMPTY_REPLAY]
  private at = 0
  private current: ReplayState = EMPTY_REPLAY

  constructor(
    readonly events: readonly ShokubaEvent[],
    private readonly checkpointEvery = Number.POSITIVE_INFINITY,
  ) {}

  get length(): number {
    return this.events.length
  }

  /** How many saved states there are to start again from, the empty start included. */
  get checkpointCount(): number {
    return this.checkpoints.length
  }

  /** The state after the first `cursor` events. */
  stateAt(cursor: number): ReplayState {
    const target = Math.min(Math.max(Math.round(cursor), 0), this.events.length)
    if (target < this.at) {
      const index = Math.min(Math.floor(target / this.checkpointEvery), this.checkpoints.length - 1)
      this.at = Number.isFinite(this.checkpointEvery) ? index * this.checkpointEvery : 0
      this.current = this.checkpoints[Number.isFinite(this.checkpointEvery) ? index : 0]!
    }
    while (this.at < target) {
      this.current = foldReplay(this.current, this.events[this.at]!)
      this.at += 1
      if (this.at === this.checkpoints.length * this.checkpointEvery)
        this.checkpoints.push(this.current)
    }
    return this.current
  }
}

/** What replay can be narrowed to: one mission, or one employee. */
export type ReplayFilter = { kind: 'mission'; id: string } | { kind: 'employee'; id: string } | null

const PEOPLE_FIELDS = [
  'employeeId',
  'fromId',
  'toId',
  'reviewerId',
  'assigneeId',
  'plannerId',
] as const

function field(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
}

/**
 * Which events are about what the filter names, by the ids each event records. An event that names
 * a task but not its mission is matched through an earlier event that named both.
 */
export function matchingEvents(events: readonly ShokubaEvent[], filter: ReplayFilter): number[] {
  if (!filter) return []
  const missionOfTask = new Map<string, string>()
  const found: number[] = []
  events.forEach((event, index) => {
    const taskId = field(event.payload, 'taskId')
    const missionId = field(event.payload, 'missionId')
    if (taskId && missionId) missionOfTask.set(taskId, missionId)
    const matches =
      filter.kind === 'mission'
        ? (missionId ?? (taskId ? missionOfTask.get(taskId) : undefined)) === filter.id
        : PEOPLE_FIELDS.some((key) => field(event.payload, key) === filter.id)
    if (matches) found.push(index)
  })
  return found
}
