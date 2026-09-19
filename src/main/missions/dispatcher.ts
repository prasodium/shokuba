import type { EventType } from '@shared/events/schema'
import type { EventStore } from '../events/store'
import { describeError, type Logger } from '../logging/logger'
import type { MissionService } from './service'

/** What the dispatcher needs from the agent runtime. */
export interface DeliveryPort {
  /** Why a prompt must not be sent to this agent right now, or null if it may be. */
  deliveryBlocker(employeeId: string): string | null
  /** Paste a prompt into the agent's terminal and press Enter. */
  deliverPrompt(employeeId: string, text: string): Promise<void>
}

/** Events after which a task might have become dispatchable. */
const TRIGGERS: ReadonlySet<EventType> = new Set([
  'task.status.changed',
  'task.assigned',
  'task.updated',
  'mission.status.changed',
  'agent.state.changed',
  'agent.started',
])

/** After a failed delivery, leave that task alone for a while instead of retrying in a loop. */
const RETRY_COOLDOWN_MS = 5_000

/**
 * Hands ready tasks to their assignees. It only acts while a mission is Running, and only
 * when the assignee is running and its state was *reported* as idle — never guessed, never
 * while it waits on a permission prompt — because the briefing is pasted into its terminal
 * and an Enter sent at the wrong moment could answer a prompt meant for a person.
 *
 * One task per agent at a time; the claim on a task is atomic, so two ticks can never hand
 * out the same one. If delivery fails the claim is undone.
 */
export class Dispatcher {
  private unsubscribe: (() => void) | undefined
  private running = false
  private again = false
  private readonly cooldown = new Map<string, number>()

  constructor(
    private readonly deps: {
      missions: MissionService
      delivery: DeliveryPort
      events: EventStore
      logger: Logger
      now?: () => number
    },
  ) {}

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.deps.events.bus.onAny((event) => {
      if (event.type === 'agent.stopped') {
        // A stopped process cannot finish what it was doing.
        try {
          this.deps.missions.blockAgentTasks(event.payload.employeeId, 'the agent stopped')
        } catch (error) {
          this.deps.logger.error('dispatcher.block.failed', describeError(error))
        }
      }
      if (TRIGGERS.has(event.type)) this.schedule()
    })
    this.schedule()
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  /** Run a dispatch pass soon. Passes never overlap; requests during one are coalesced. */
  private schedule(): void {
    queueMicrotask(() => {
      // A pass queued before `stop()` must not run after it.
      if (this.unsubscribe) void this.tick()
    })
  }

  /** One dispatch pass. Public so tests can drive it deterministically. */
  async tick(): Promise<void> {
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    try {
      do {
        this.again = false
        await this.pass()
      } while (this.again)
    } finally {
      this.running = false
    }
  }

  private async pass(): Promise<void> {
    const { missions, delivery, logger } = this.deps
    const now = (this.deps.now ?? Date.now)()
    const claimedAgents = new Set<string>()

    for (const task of missions.dispatchCandidates()) {
      const agent = task.assigneeId
      if (agent === null || claimedAgents.has(agent)) continue
      if ((this.cooldown.get(task.id) ?? 0) > now) continue
      if (missions.hasActiveTask(agent)) continue
      if (delivery.deliveryBlocker(agent) !== null) continue

      claimedAgents.add(agent)
      let claimed
      try {
        claimed = missions.markDispatched(task.id)
      } catch {
        continue // someone else changed it first
      }

      try {
        await delivery.deliverPrompt(agent, missions.briefing(task.id))
        missions.announceDispatched(claimed)
        this.cooldown.delete(task.id)
      } catch (error) {
        const { message } = describeError(error)
        logger.warn('dispatcher.delivery.failed', { taskId: task.id, employeeId: agent, message })
        this.cooldown.set(task.id, now + RETRY_COOLDOWN_MS)
        missions.revertDispatch(task.id, `could not reach the agent: ${message}`)
        // Try again after the cooldown even if nothing else happens in the meantime.
        setTimeout(() => this.schedule(), RETRY_COOLDOWN_MS + 50).unref?.()
      }
    }
  }
}
