import type { ShokubaEvent } from '@shared/events/schema'

/**
 * A way to hear about events as they happen, and only then. The event store keeps history for views
 * to read; a picture that wants to react to *news* (a card flying across the office) must not
 * replay history when it opens, so it listens here instead.
 */

type Listener = (event: ShokubaEvent) => void

const listeners = new Set<Listener>()

/** Call `listener` for every event that arrives from now on. Returns a function that stops it. */
export function onLiveEvent(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Tell every listener about an event that has just happened. One that fails does not stop the rest. */
export function emitLiveEvent(event: ShokubaEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch {
      /* a picture that cannot draw something must never break the event stream */
    }
  }
}
