import { create } from 'zustand'
import type { ShokubaEvent } from '@shared/events/schema'

const MAX_KEPT = 500

interface EventsState {
  events: ShokubaEvent[]
  /** Merge events in by seq; duplicates (from the subscribe/list race) are dropped. */
  ingest(incoming: readonly ShokubaEvent[]): void
}

export const useEvents = create<EventsState>((set) => ({
  events: [],
  ingest: (incoming) =>
    set((state) => {
      const bySeq = new Map(state.events.map((event) => [event.seq, event]))
      for (const event of incoming) bySeq.set(event.seq, event)
      const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
      return { events: merged.slice(-MAX_KEPT) }
    }),
}))
