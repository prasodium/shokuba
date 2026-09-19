import type { AgentView } from '@shared/agents/view'
import type { EventSource } from '@shared/events/schema'
import type { RuntimeState } from '@shared/types/agent'

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

/** Provenance of a state as the UI should label it; null when it needs no label. */
export type Provenance = 'inferred' | 'demo' | null

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
  /** Whether the bubble should be drawn at all. */
  visible: boolean
}

const MAX_DETAIL = 34

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** What the status bubble above an employee says, from their current view. */
export function bubbleFor(view: AgentView | undefined): BubbleModel {
  if (!view) return { label: 'Offline', detail: null, tone: 'off', provenance: null, visible: true }

  const detail =
    view.state === 'error'
      ? view.error
      : view.state === 'waiting'
        ? view.reason
        : (view.activity?.summary ?? null)

  return {
    label: STATE_LABELS[view.state],
    detail: detail ? clip(detail, MAX_DETAIL) : null,
    tone: TONES[view.state],
    provenance: provenance(view.stateSource),
    visible: true,
  }
}

export function toneOf(state: RuntimeState): Tone {
  return TONES[state]
}
