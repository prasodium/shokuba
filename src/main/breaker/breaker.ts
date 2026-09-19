import { levelRank, type BreakerLevel, type BreakerRule, type BreakerState } from '@shared/breaker'
import type { EventInput, ShokubaEvent } from '@shared/events/schema'
import type { AuditLog } from '../events/audit'
import type { EventStore } from '../events/store'
import { describeError, type Logger } from '../logging/logger'
import { HAND_BACK_TOOLS } from '../mcp/agent-tools'
import { AgentMeter, THRESHOLDS, callKey, isEditTool, type Finding } from './rules'

/** What the breaker can do to a running agent. */
export interface BreakerPort {
  isRunning(employeeId: string): boolean
  /** Ctrl+C: end the current turn. */
  interrupt(employeeId: string): void
  stop(employeeId: string): Promise<void>
}

interface AgentState {
  level: BreakerLevel
  rule: BreakerRule | null
  detail: string | null
  /** When something last raised this level; a warning fades once things have been quiet. */
  lastTripAt: number
}

/** How often to look for things that need no event to notice (a turn that will not end). */
const SWEEP_MS = 30_000

/** The most it will do on its own. STOP is only ever a person's decision. */
const MAX_AUTOMATIC_LEVEL: BreakerLevel = 'pause'

/**
 * Watches what agents do and restrains them when it looks like a runaway. It reads the same
 * event stream as everything else, and every change of level is an event, so what it decided
 * is on the record and a window that opens later sees the same thing.
 *
 * What each level actually does:
 *  - warning:   nothing but the flag
 *  - constrain: no new tasks, no agent-to-agent messages, and the looping call (or further
 *               edits, if too many files have changed) is denied, with a reason the agent reads
 *  - pause:     every tool call is denied except the hand-back tools, and the running turn is
 *               interrupted
 *  - stop:      the process is ended (a person's decision only)
 *
 * It escalates by itself up to PAUSE and never lowers a level by itself, except that a warning
 * fades after ten quiet minutes. A person lowers anything with Reset.
 *
 * Limits: "the same call" is the same tool with the same short summary; a loop inside one shell
 * script is invisible to hooks; edits made through the shell are not counted; and cost is not
 * measurable.
 */
export class CircuitBreaker {
  private readonly states = new Map<string, AgentState>()
  private readonly meters = new Map<string, AgentMeter>()
  /** Calls it refused, so they are not then counted as the agent's failures. */
  private readonly refused = new Set<string>()
  private unsubscribe: (() => void) | undefined
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly deps: {
      events: EventStore
      port: BreakerPort
      audit: AuditLog
      logger: Logger
      /** Who took part in a conversation, to flag them when it is halted as a possible loop. */
      participants: (conversationId: string) => string[]
      now?: () => number
    },
  ) {}

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.deps.events.bus.onAny((event) => {
      try {
        this.onEvent(event)
      } catch (error) {
        this.deps.logger.error('breaker.event.failed', {
          type: event.type,
          ...describeError(error),
        })
      }
    })
    this.timer = setInterval(() => this.sweep(), SWEEP_MS)
    this.timer.unref?.()
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  // ---------- what others ask ----------

  stateOf(employeeId: string): BreakerState {
    const state = this.states.get(employeeId)
    return {
      level: state?.level ?? 'normal',
      rule: state?.rule ?? null,
      detail: state?.detail ?? null,
    }
  }

  levelOf(employeeId: string): BreakerLevel {
    return this.states.get(employeeId)?.level ?? 'normal'
  }

  /** May this agent be given a new task? */
  allowsTasks(employeeId: string): boolean {
    return levelRank(this.levelOf(employeeId)) < levelRank('constrain')
  }

  /**
   * May a message be delivered to this agent? A constrained agent still hears from the person
   * (that is how a person steers it) but not from other agents; a paused one hears from no one.
   */
  allowsDelivery(employeeId: string, fromPerson: boolean): boolean {
    const level = this.levelOf(employeeId)
    if (levelRank(level) >= levelRank('pause')) return false
    if (level === 'constrain') return fromPerson
    return true
  }

  /** Why this agent may not message its teammates, or null if it may. */
  messageBlocker(employeeId: string): string | null {
    if (levelRank(this.levelOf(employeeId)) < levelRank('constrain')) return null
    const { detail } = this.stateOf(employeeId)
    return (
      `Shokuba's circuit breaker has limited you${detail ? ` (${detail})` : ''}, so you cannot message teammates. ` +
      'If you need help, use report_blocked or message the person you work for (to: "human").'
    )
  }

  /**
   * Called for every tool call, just before it would run. Returns a reason to refuse it, or
   * null to let it run. Refusing a call is recorded, and tells the agent why.
   */
  decide(employeeId: string, toolName: string, summary: string, toolUseId?: string): string | null {
    const state = this.states.get(employeeId)
    if (!state || levelRank(state.level) < levelRank('constrain')) return null

    const reason = this.refusalFor(employeeId, state, toolName, summary)
    if (reason === null) return null

    if (toolUseId) this.refused.add(toolUseId)
    this.deps.events.publish({
      type: 'breaker.denied',
      source: 'system',
      actorId: employeeId,
      payload: { employeeId, toolName, reason },
    })
    return reason
  }

  // ---------- what a person can do ----------

  reset(employeeId: string): void {
    this.meter(employeeId).reset()
    this.setLevel(employeeId, 'normal', 'manual', 'reset by you', 'user')
  }

  pause(employeeId: string): void {
    if (levelRank(this.levelOf(employeeId)) >= levelRank('pause')) return
    this.setLevel(employeeId, 'pause', 'manual', 'paused by you', 'user')
    this.interrupt(employeeId)
  }

  async stopAgent(employeeId: string): Promise<void> {
    this.setLevel(employeeId, 'stop', 'manual', 'stopped by you', 'user')
    await this.deps.port.stop(employeeId)
  }

  // ---------- internals ----------

  private refusalFor(
    employeeId: string,
    state: AgentState,
    toolName: string,
    summary: string,
  ): string | null {
    const meter = this.meter(employeeId)
    const why = state.detail ? ` (${state.detail})` : ''

    if (levelRank(state.level) >= levelRank('pause')) {
      if (HAND_BACK_TOOLS.has(toolName)) return null
      return (
        `Shokuba's circuit breaker has paused you${why}. Do not use any more tools except submit_task or report_blocked. ` +
        'A person will decide what happens next.'
      )
    }

    // Constrained: refuse only what is running away.
    if (meter.repeatCount(callKey(toolName, summary)) >= THRESHOLDS.repeatedCalls.constrain) {
      return (
        `Shokuba's circuit breaker has stopped this call${why}. You have made it many times in a row without progress. ` +
        'Do not repeat it. Try a different approach, or use report_blocked to ask a person for help.'
      )
    }
    if (isEditTool(toolName) && meter.editedFileCount() >= THRESHOLDS.fileChanges.constrain) {
      return (
        `Shokuba's circuit breaker has stopped further edits${why}. Too many different files have been changed in this task. ` +
        'Stop editing and use submit_task to hand it back for review, or report_blocked.'
      )
    }
    return null
  }

  private onEvent(event: ShokubaEvent): void {
    const now = this.now()
    switch (event.type) {
      case 'agent.tool.started': {
        const { employeeId, toolName, summary } = event.payload
        this.meter(employeeId).toolStarted(toolName, summary)
        this.evaluate(employeeId)
        break
      }
      case 'agent.tool.finished': {
        const { employeeId, ok, toolUseId } = event.payload
        // A call the breaker itself refused "failed" only because it was refused.
        if (toolUseId !== undefined && this.refused.delete(toolUseId)) break
        this.meter(employeeId).toolFinished(ok)
        this.evaluate(employeeId)
        break
      }
      case 'agent.turn.started':
        this.meter(event.payload.employeeId).turnStarted(now)
        break
      case 'agent.turn.finished':
        this.meter(event.payload.employeeId).turnFinished()
        break
      case 'agent.error':
        if (event.payload.code === 'turn-failed') {
          this.meter(event.payload.employeeId).turnFailed(now)
          this.evaluate(event.payload.employeeId)
        }
        break
      case 'task.dispatched':
        // Files edited so far belong to the last task.
        this.meter(event.payload.employeeId).taskStarted()
        break
      case 'conversation.status.changed':
        if (event.payload.to === 'halted') {
          for (const employeeId of this.deps.participants(event.payload.conversationId)) {
            this.meter(employeeId).conversationHalted(now)
            this.evaluate(employeeId)
          }
        }
        break
      case 'agent.started': {
        // A fresh process gets a clean slate: starting it again is a person's decision.
        const { employeeId } = event.payload
        this.meter(employeeId).reset()
        if (this.levelOf(employeeId) !== 'normal') {
          this.setLevel(employeeId, 'normal', 'restarted', 'the agent was started again', 'system')
        }
        break
      }
      default:
        break
    }
  }

  /** Raise the level if the meter says something has been tripped. Never lowers it. */
  private evaluate(employeeId: string): void {
    const finding = this.meter(employeeId).assess(this.now())
    if (finding) this.raise(employeeId, finding)
  }

  private raise(employeeId: string, finding: Finding): void {
    const current = this.states.get(employeeId)
    const capped: BreakerLevel =
      levelRank(finding.level) > levelRank(MAX_AUTOMATIC_LEVEL)
        ? MAX_AUTOMATIC_LEVEL
        : finding.level
    if (current && levelRank(capped) <= levelRank(current.level)) {
      if (current.level === capped) current.lastTripAt = this.now()
      return
    }
    this.setLevel(employeeId, capped, finding.rule, finding.detail, 'system')
    if (capped === 'pause') this.interrupt(employeeId)
  }

  private setLevel(
    employeeId: string,
    to: BreakerLevel,
    rule: BreakerRule,
    detail: string,
    source: 'system' | 'user',
  ): void {
    const from = this.levelOf(employeeId)
    if (from === to && to === 'normal') return
    this.states.set(employeeId, {
      level: to,
      rule: to === 'normal' ? null : rule,
      detail: to === 'normal' ? null : detail,
      lastTripAt: this.now(),
    })
    const event: EventInput = {
      type: 'breaker.state.changed',
      source,
      actorId: employeeId,
      payload: { employeeId, from, to, rule, detail: detail.slice(0, 300) },
    }
    this.deps.events.publish(event)
    this.deps.audit.record({
      actor: source === 'user' ? 'user' : 'system',
      action: `breaker.${to}`,
      target: employeeId,
      detail: { from, rule, detail },
    })
  }

  private interrupt(employeeId: string): void {
    if (!this.deps.port.isRunning(employeeId)) return
    try {
      this.deps.port.interrupt(employeeId)
    } catch (error) {
      this.deps.logger.warn('breaker.interrupt.failed', { employeeId, ...describeError(error) })
    }
  }

  /**
   * Things that need the passing of time rather than an event: a turn that will not end, a
   * warning that has gone quiet. Runs on a timer; public so tests can run it on demand.
   */
  sweep(): void {
    const now = this.now()
    for (const employeeId of this.meters.keys()) {
      try {
        this.evaluate(employeeId)
        const state = this.states.get(employeeId)
        if (
          state?.level === 'warning' &&
          now - state.lastTripAt >= THRESHOLDS.warningClearsAfterMs &&
          this.meter(employeeId).assess(now) === null
        ) {
          this.setLevel(
            employeeId,
            'normal',
            state.rule ?? 'manual',
            'quiet for ten minutes',
            'system',
          )
        }
      } catch (error) {
        this.deps.logger.error('breaker.sweep.failed', { employeeId, ...describeError(error) })
      }
    }
  }

  private meter(employeeId: string): AgentMeter {
    let meter = this.meters.get(employeeId)
    if (!meter) {
      meter = new AgentMeter()
      this.meters.set(employeeId, meter)
    }
    return meter
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}
