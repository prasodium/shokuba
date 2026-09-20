import type { ShokubaEvent } from '@shared/events/schema'
import { HUMAN } from '@shared/messages'

/**
 * Work changing hands, as pictures. Pure: a recorded event goes in, and out comes what to draw, if
 * anything. Nothing here is invented: every flight is one event that really happened, and events
 * that are not about work moving are ignored. What each flight shows:
 *
 *  - a task handed to an agent: its card goes from the mission board to their desk
 *  - work submitted: a card goes from their person to your inbox
 *  - accepted: the card goes from your inbox back up to the board, stamped green
 *  - sent back: the card goes from your inbox to their desk, marked red
 *  - a review handed in: a card goes from the reviewer to your inbox, marked with their verdict
 *  - a message between two people: an envelope goes from one to the other (you are your inbox)
 *
 * The scene turns an endpoint into a place in the room; this module knows nothing about the floor.
 */

/** Somewhere a flight starts or ends. */
export type Endpoint =
  | { at: 'board' }
  | { at: 'inbox' }
  /** An employee's desk, wherever their person is. */
  | { at: 'desk'; id: string }
  /** An employee's person, wherever they are standing or sitting right now. */
  | { at: 'person'; id: string }

/** How the thing flying is marked: plain paper, or a verdict on it. */
export type Tint = 'plain' | 'good' | 'bad' | 'warn'

export interface Flight {
  /** One per event, so the same event never flies twice. */
  key: string
  thing: 'card' | 'envelope'
  from: Endpoint
  to: Endpoint
  tint: Tint
}

/** What a flight needs to know that the event does not say. */
export interface HandoffContext {
  /** Who a task is assigned to, or null if nobody. */
  assigneeOf(taskId: string): string | null
}

const VERDICT_TINTS = {
  approve: 'good',
  request_changes: 'bad',
  comment: 'warn',
} as const satisfies Record<string, Tint>

/** You are your inbox: mail from or to you goes there, and anyone else has a person and a desk. */
function sender(id: string): Endpoint {
  return id === HUMAN ? { at: 'inbox' } : { at: 'person', id }
}

function recipient(id: string): Endpoint {
  return id === HUMAN ? { at: 'inbox' } : { at: 'desk', id }
}

/** The flight this event calls for, or null if it is not about work moving. */
export function flightFor(event: ShokubaEvent, ctx: HandoffContext): Flight | null {
  const key = String(event.seq)
  switch (event.type) {
    case 'task.dispatched':
      return {
        key,
        thing: 'card',
        from: { at: 'board' },
        to: { at: 'desk', id: event.payload.employeeId },
        tint: 'plain',
      }
    case 'task.status.changed': {
      const assignee = ctx.assigneeOf(event.payload.taskId)
      switch (event.payload.to) {
        case 'submitted':
          return assignee
            ? { key, thing: 'card', from: sender(assignee), to: { at: 'inbox' }, tint: 'plain' }
            : null
        case 'done':
          return { key, thing: 'card', from: { at: 'inbox' }, to: { at: 'board' }, tint: 'good' }
        case 'changes_requested':
          return assignee
            ? { key, thing: 'card', from: { at: 'inbox' }, to: recipient(assignee), tint: 'bad' }
            : null
        default:
          return null
      }
    }
    case 'review.changed':
      return event.payload.change === 'submitted'
        ? {
            key,
            thing: 'card',
            from: sender(event.payload.reviewerId),
            to: { at: 'inbox' },
            tint: event.payload.verdict ? VERDICT_TINTS[event.payload.verdict] : 'plain',
          }
        : null
    case 'message.sent':
      // A note to oneself would fly nowhere.
      return event.payload.fromId === event.payload.toId
        ? null
        : {
            key,
            thing: 'envelope',
            from: sender(event.payload.fromId),
            to: recipient(event.payload.toId),
            tint: 'plain',
          }
    default:
      return null
  }
}

// ---------- in the air ----------

/** How long one flight takes. */
export const FLIGHT_MS = 1500
/** How many can be in the air at once; more wait their turn. */
export const MAX_FLYING = 6
/** How many can wait. A burst of events shows its latest, never a long backlog of old news. */
export const MAX_WAITING = 6
/** A flight that has waited this long is not shown at all: it would be a picture of the past. */
export const STALE_MS = 6_000

export interface Flying {
  flight: Flight
  /** 0 as it leaves, 1 as it lands. */
  progress: number
}

/**
 * The flights in the air and the ones waiting. Events can come in bursts, so only so many fly at
 * once, the rest wait in order, and a flight that has waited too long, or that a longer queue has
 * pushed out, is dropped rather than shown late. Nothing here reads a clock: the time is passed in.
 */
export class FlightQueue {
  private waiting: Array<{ flight: Flight; queuedAt: number }> = []
  private flying: Array<{ flight: Flight; startedAt: number }> = []

  push(flight: Flight, now: number): void {
    this.waiting.push({ flight, queuedAt: now })
    // Nobody is watching if the window is hidden and nothing takes off, so the line cannot grow
    // without end. The oldest go first: the newest news is what the office should show.
    while (this.waiting.length > MAX_FLYING + MAX_WAITING) this.waiting.shift()
  }

  /** Move on to `now`: what has taken off since the last call, and everything now in the air. */
  update(now: number): { started: Flight[]; flying: Flying[] } {
    this.flying = this.flying.filter((f) => now - f.startedAt < FLIGHT_MS)
    this.waiting = this.waiting.filter((w) => now - w.queuedAt <= STALE_MS)

    const started: Flight[] = []
    while (this.flying.length < MAX_FLYING) {
      const next = this.waiting.shift()
      if (!next) break
      this.flying.push({ flight: next.flight, startedAt: now })
      started.push(next.flight)
    }
    while (this.waiting.length > MAX_WAITING) this.waiting.shift()
    return {
      started,
      flying: this.flying.map((f) => ({
        flight: f.flight,
        progress: Math.min(1, Math.max(0, (now - f.startedAt) / FLIGHT_MS)),
      })),
    }
  }

  /** Forget everything, as when the office is closed. */
  clear(): void {
    this.waiting = []
    this.flying = []
  }
}

export interface Point3 {
  x: number
  y: number
  z: number
}

/** How high a flight arcs above the straight line between its ends at the top, in tiles. */
export const ARC_HEIGHT = 0.7

/** Slow at both ends, quick in the middle. */
export function ease(t: number): number {
  const c = Math.min(1, Math.max(0, t))
  return c * c * (3 - 2 * c)
}

/** Where a flight is at `progress`: along the straight line on the floor, lifted in an arc. */
export function flightPoint(from: Point3, to: Point3, progress: number): Point3 {
  const t = ease(progress)
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    z: from.z + (to.z - from.z) * t + ARC_HEIGHT * Math.sin(Math.PI * t),
  }
}
