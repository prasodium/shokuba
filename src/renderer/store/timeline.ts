import type { AgentView } from '@shared/agents/view'
import type { ShokubaEvent } from '@shared/events/schema'
import { shokuba } from '../api'
import { setReplaying } from '../replay/mode'
import { useOffice } from './office'
import { createTimelineStore } from './timelineStore'

type Listener = (event: ShokubaEvent) => void
const listeners = new Set<Listener>()

/** Hear each event replay plays (never one it seeks past), to draw it as it happens. */
export function onReplayEvent(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useTimeline = createTimelineStore({
  list: (afterSeq, limit) => shokuba.events.list({ afterSeq, limit }),
  now: () => performance.now(),
  every: (fn, ms) => {
    const id = window.setInterval(fn, ms)
    return () => window.clearInterval(id)
  },
  setReplaying,
  emit: (events) => {
    for (const event of events) {
      for (const listener of [...listeners]) {
        try {
          listener(event)
        } catch {
          /* a picture that cannot draw something must never stop replay */
        }
      }
    }
  },
})

/** The one time source: the agents' views live, or at the replay cursor. */
export function useShownViews(): Record<string, AgentView> {
  const live = useOffice((s) => s.views)
  const replay = useTimeline((s) => (s.mode === 'replay' ? s.state.agents.views : null))
  return replay ?? live
}

export function useReplaying(): boolean {
  return useTimeline((s) => s.mode !== 'live')
}
