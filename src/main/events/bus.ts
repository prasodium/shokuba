import type { EventOfType, EventType, ShokubaEvent } from '@shared/events/schema'

export type Listener<E> = (event: E) => void
export type Unsubscribe = () => void
export type ListenerErrorHandler = (error: unknown, event: ShokubaEvent) => void

/**
 * In-process typed event bus. The office, the command center and analytics all subscribe
 * here and know nothing about each other.
 *
 *  - Delivery is FIFO even when a listener publishes another event while handling one
 *    (the nested event is queued, not delivered ahead of the rest of the current batch).
 *  - A throwing listener is reported and skipped; it can never break other listeners
 *    or the publisher.
 */
export class EventBus {
  private readonly byType = new Map<EventType, Set<Listener<ShokubaEvent>>>()
  private readonly all = new Set<Listener<ShokubaEvent>>()
  private readonly queue: ShokubaEvent[] = []
  private draining = false

  constructor(private readonly onListenerError: ListenerErrorHandler = () => {}) {}

  on<T extends EventType>(type: T, listener: Listener<EventOfType<T>>): Unsubscribe {
    const set = this.byType.get(type) ?? new Set<Listener<ShokubaEvent>>()
    const stored = listener as Listener<ShokubaEvent>
    set.add(stored)
    this.byType.set(type, set)
    return () => {
      set.delete(stored)
    }
  }

  onAny(listener: Listener<ShokubaEvent>): Unsubscribe {
    this.all.add(listener)
    return () => {
      this.all.delete(listener)
    }
  }

  emit(event: ShokubaEvent): void {
    this.queue.push(event)
    if (this.draining) return

    this.draining = true
    try {
      for (let next = this.queue.shift(); next !== undefined; next = this.queue.shift()) {
        this.dispatch(next)
      }
    } finally {
      this.draining = false
    }
  }

  private dispatch(event: ShokubaEvent): void {
    // Snapshot so a listener may unsubscribe itself (or others) mid-dispatch.
    const listeners = [...(this.byType.get(event.type) ?? []), ...this.all]
    for (const listener of listeners) {
      try {
        listener(event)
      } catch (error) {
        try {
          this.onListenerError(error, event)
        } catch {
          // The error handler itself failed; nothing sensible left to do.
        }
      }
    }
  }
}
