import type { AgentView } from '@shared/agents/view'
import type { BreakerLevel } from '@shared/breaker'
import type { EventSource } from '@shared/events/schema'
import type { RuntimeState } from '@shared/types/agent'
import type { PlaceKind } from './map'

/** How urgent or lively a state looks. Drives colour, never meaning. */
export type Tone = 'off' | 'idle' | 'busy' | 'wait' | 'error'

export const STATE_LABELS: Record<RuntimeState, string> = {
  offline: 'Offline',
  starting: 'Starting',
  idle: 'Idle',
  thinking: 'Thinking',
  coding: 'Coding',
  testing: 'Testing',
  researching: 'Researching',
  reviewing: 'Reviewing',
  waiting: 'Needs you',
  blocked: 'Blocked',
  paused: 'Paused',
  error: 'Error',
  stopped: 'Stopped',
}

const TONES: Record<RuntimeState, Tone> = {
  offline: 'off',
  stopped: 'off',
  paused: 'off',
  starting: 'idle',
  idle: 'idle',
  thinking: 'busy',
  coding: 'busy',
  testing: 'busy',
  researching: 'busy',
  reviewing: 'busy',
  waiting: 'wait',
  blocked: 'wait',
  error: 'error',
}

/** What each circuit-breaker level is called, and what it means, for a person reading it. */
export const BREAKER_LABELS: Record<Exclude<BreakerLevel, 'normal'>, string> = {
  warning: 'Warning',
  constrain: 'Limited',
  pause: 'Paused',
  stop: 'Stopped',
}

export const BREAKER_HELP: Record<Exclude<BreakerLevel, 'normal'>, string> = {
  warning: 'Shokuba noticed something unusual. Nothing is restricted yet.',
  constrain:
    'No new tasks or teammate messages. The call it keeps repeating (or further edits) is refused.',
  pause: 'Interrupted. Every tool call is refused except handing the work back. Reset to resume.',
  stop: 'Stopped by you.',
}

/** Provenance of a state as the UI should label it; null when it needs no label. */
export type Provenance = 'inferred' | 'demo' | null

/**
 * Why someone is away from their desk, which decides how the bubble labels it: our reading of what
 * their agent is doing (`inferred`), a recorded fact such as a review they were given (`recorded`),
 * or the office's own simulated life (`simulated`), which is never a fact about the agent.
 */
export type Trip = 'inferred' | 'recorded' | 'simulated'

export function provenance(source: EventSource): Provenance {
  if (source === 'simulated') return 'demo'
  if (source === 'inferred') return 'inferred'
  // `reported` (the agent said so) and `system`/`user` (Shokuba itself) are facts.
  return null
}

export interface BubbleModel {
  label: string
  /** What it is doing right now, when known (a file, a command), else null. */
  detail: string | null
  tone: Tone
  provenance: Provenance
  /** Set when the circuit breaker is restraining the agent, so the office shows it at a glance. */
  caution: 'limited' | 'paused' | null
  /** Set when where they are is simulated office life, and not anything their agent did. */
  simulated: boolean
  /** Whether the bubble should be drawn at all. */
  visible: boolean
}

const MAX_DETAIL = 34

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** How the bubble says where someone is when they are away from their desk. */
export const AWAY_NOTES: Record<PlaceKind, string> = {
  qa: 'at the QA bench',
  reading: 'in the reading room',
  inbox: 'at your inbox',
  board: 'at the mission board',
  tea: 'at the tea corner',
  snacks: 'at the snack corner',
  meeting: 'in the meeting room',
  chat: 'at the pantry table',
}

/**
 * What the status bubble above an employee says, from their current view. `awayAt` is the kind of
 * place they have gone to, if they are not at their desk, and `trip` says why: our reading of what
 * their agent is doing, a recorded fact (a review Shokuba handed them), or simulated office life.
 * `brief` leaves out where they are, for a group that is already together (five bubbles all saying
 * "in the meeting room" would bury the room); the label and every mark stay.
 */
export function bubbleFor(
  view: AgentView | undefined,
  awayAt: PlaceKind | null = null,
  trip: Trip = 'inferred',
  brief = false,
): BubbleModel {
  if (!view) {
    return {
      label: 'Offline',
      detail: null,
      tone: 'off',
      provenance: null,
      caution: null,
      simulated: false,
      visible: true,
    }
  }

  const detail =
    view.state === 'error'
      ? view.error
      : view.state === 'waiting'
        ? view.reason
        : (view.activity?.summary ?? null)

  // Only while it is running: a stopped agent's state already says so.
  const restrained = view.pid !== null
  const caution: BubbleModel['caution'] =
    restrained && view.breakerLevel === 'constrain'
      ? 'limited'
      : restrained && view.breakerLevel === 'pause'
        ? 'paused'
        : null
  const tone = TONES[view.state]

  // Going somewhere because of what an agent is doing is our reading of it, never something the agent
  // said, so someone who is away for that is marked as such (a demo stays a demo). A trip that is a
  // recorded fact, or the office's own simulated life, carries only the state's own label (the second
  // has a note of its own).
  const provenanceNow: Provenance =
    awayAt && trip === 'inferred'
      ? view.stateSource === 'simulated'
        ? 'demo'
        : 'inferred'
      : provenance(view.stateSource)

  return {
    label: STATE_LABELS[view.state],
    detail: awayAt ? (brief ? null : AWAY_NOTES[awayAt]) : detail ? clip(detail, MAX_DETAIL) : null,
    // Amber, like anything else that needs a person's eye; a real error stays red.
    tone: caution && tone !== 'error' ? 'wait' : tone,
    provenance: provenanceNow,
    caution,
    simulated: awayAt !== null && trip === 'simulated',
    visible: true,
  }
}

export function toneOf(state: RuntimeState): Tone {
  return TONES[state]
}
