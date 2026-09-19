import type { EventInput, EventSource } from '@shared/events/schema'
import type { RuntimeState } from '@shared/types/agent'
import type { AgentSignal, ToolActivity } from '../providers/types'

/** Events the tracker wants published; the runtime publishes them through the EventStore. */
export type TrackerOutput = EventInput

const WORKING: ReadonlySet<RuntimeState> = new Set([
  'thinking',
  'coding',
  'testing',
  'researching',
  'reviewing',
])

interface ActiveTool {
  toolName: string
  activity: ToolActivity
}

/**
 * Derives one agent's runtime state from what it reports. Pure: signals in, events out,
 * no I/O — so every transition rule is unit-tested.
 *
 * Rules worth knowing:
 *  - A signal is only ever a *claim*. The state changes on claims, and each transition is
 *    labelled with how we know (`reported` by the agent, `inferred` by our classification,
 *    or `simulated` for the demo provider).
 *  - Several tools can run at once (parallel calls). The agent stays "working" until the
 *    last one finishes, and shows the most recently started one.
 *  - Nothing here decides an agent is *finished*. Only a turn-finished signal or the
 *    process exiting does — not a guess from silence.
 */
export class AgentTracker {
  private current: RuntimeState = 'offline'
  private readonly active = new Map<string, ActiveTool>()
  private anonymous = 0

  constructor(
    private readonly employeeId: string,
    /** How events derived from this agent's own signals are labelled. */
    private readonly channelSource: Extract<EventSource, 'reported' | 'simulated'>,
  ) {}

  get state(): RuntimeState {
    return this.current
  }

  /** The process is being launched. */
  start(): TrackerOutput[] {
    this.active.clear()
    return this.transition('starting', 'launching', 'system')
  }

  /** The process is gone. `clean` means we asked it to stop or it exited 0. */
  exited(clean: boolean, reason: string): TrackerOutput[] {
    this.active.clear()
    return this.transition(clean ? 'stopped' : 'error', reason, 'system')
  }

  /**
   * The user sent Ctrl+C or Esc to the terminal. Claude Code does not report an
   * interrupted turn, so without this an interrupted agent would look busy forever. This is
   * a guess (the key might have done nothing), so it is labelled `inferred`, and any real
   * signal that follows corrects it.
   */
  interrupted(): TrackerOutput[] {
    if (!WORKING.has(this.current) && this.current !== 'waiting') return []
    this.active.clear()
    return this.transition('idle', 'interrupted from the terminal', 'inferred')
  }

  onSignal(signal: AgentSignal): TrackerOutput[] {
    const out: TrackerOutput[] = []

    // The first report proves the agent is up, even if it never sent SessionStart.
    if (this.current === 'starting' && signal.kind !== 'session-ended') {
      out.push(this.event('agent.ready', {}, this.channelSource))
      out.push(...this.transition('idle', 'the agent reported in', this.channelSource))
    }

    switch (signal.kind) {
      case 'session-started':
        break

      case 'turn-started':
        this.active.clear()
        out.push(this.event('agent.turn.started', {}, this.channelSource))
        out.push(...this.transition('thinking', 'working on a prompt', this.channelSource))
        break

      case 'tool-started': {
        const key = signal.toolUseId ?? `anonymous-${this.anonymous++}`
        this.active.set(key, { toolName: signal.toolName, activity: signal.activity })
        out.push(
          this.event(
            'agent.tool.started',
            {
              toolName: signal.toolName,
              summary: signal.summary,
              ...(signal.toolUseId && { toolUseId: signal.toolUseId }),
            },
            this.channelSource,
          ),
        )
        out.push(
          ...this.transition(
            signal.activity.state,
            signal.summary,
            signal.activity.inferred ? 'inferred' : this.channelSource,
          ),
        )
        break
      }

      case 'tool-finished': {
        if (signal.toolUseId) this.active.delete(signal.toolUseId)
        else this.dropOldest(signal.toolName)
        out.push(
          this.event(
            'agent.tool.finished',
            {
              toolName: signal.toolName,
              ok: signal.ok,
              ...(signal.durationMs !== undefined && { durationMs: signal.durationMs }),
              ...(signal.toolUseId && { toolUseId: signal.toolUseId }),
            },
            this.channelSource,
          ),
        )
        const remaining = [...this.active.values()].at(-1)
        out.push(
          ...(remaining
            ? this.transition(
                remaining.activity.state,
                `still using ${remaining.toolName}`,
                remaining.activity.inferred ? 'inferred' : this.channelSource,
              )
            : this.transition('thinking', 'tool finished', this.channelSource)),
        )
        break
      }

      case 'attention':
        out.push(
          this.event(
            'agent.attention',
            { reason: signal.reason, message: signal.message },
            this.channelSource,
          ),
        )
        out.push(...this.transition('waiting', signal.message, this.channelSource))
        break

      case 'turn-finished':
        this.active.clear()
        out.push(this.event('agent.turn.finished', {}, this.channelSource))
        out.push(...this.transition('idle', 'finished the turn', this.channelSource))
        break

      case 'turn-failed':
        this.active.clear()
        out.push(
          this.event(
            'agent.error',
            { code: 'turn-failed', message: signal.message },
            this.channelSource,
          ),
        )
        out.push(...this.transition('error', signal.message, this.channelSource))
        break

      case 'session-ended':
        // `/clear` ends one session and starts another inside the same process, so this is
        // not the end of the agent. The process exiting is.
        this.active.clear()
        if (this.current !== 'idle') {
          out.push(
            ...this.transition('idle', `session ended (${signal.reason})`, this.channelSource),
          )
        }
        break
    }

    return out
  }

  private dropOldest(toolName: string): void {
    for (const [key, tool] of this.active) {
      if (tool.toolName === toolName) {
        this.active.delete(key)
        return
      }
    }
  }

  private transition(to: RuntimeState, reason: string, source: EventSource): TrackerOutput[] {
    if (to === this.current) return []
    const from = this.current
    this.current = to
    return [this.event('agent.state.changed', { from, to, reason: reason.slice(0, 500) }, source)]
  }

  private event<T extends TrackerOutput['type']>(
    type: T,
    payload: Record<string, unknown>,
    source: EventSource,
  ): TrackerOutput {
    // The payload shapes are enforced by EventInputSchema when the store validates them.
    return {
      type,
      source,
      actorId: this.employeeId,
      payload: { employeeId: this.employeeId, ...payload },
    } as TrackerOutput
  }
}
