import type { AgentView } from '@shared/agents/view'
import type { ShokubaEvent } from '@shared/events/schema'

/**
 * The people replay can draw at a moment: those hired by then (they have a view) and still here
 * today (Shokuba only knows how someone looks from who works here now).
 */
export function presentAt<T extends { id: string }>(
  employees: readonly T[],
  views: Readonly<Record<string, AgentView>>,
): T[] {
  return employees.filter((employee) => employee.id in views)
}

/** How many people were there at that moment but have since been removed, so cannot be drawn. */
export function removedSince(
  employees: readonly { id: string }[],
  views: Readonly<Record<string, AgentView>>,
): number {
  const here = new Set(employees.map((employee) => employee.id))
  return Object.keys(views).filter((id) => !here.has(id)).length
}

/** Where the cursor is, in words: the last event that has happened, and how far through it is. */
export function positionLabel(
  events: readonly ShokubaEvent[],
  cursor: number,
  formatTime: (iso: string) => string,
): string {
  const total = events.length
  if (total === 0) return 'The log is empty'
  const last = events[Math.min(cursor, total) - 1]
  if (!last) return `Before the first event · 0 of ${total}`
  return `#${last.seq} · ${formatTime(last.ts)} · ${Math.min(cursor, total)} of ${total}`
}

/** The newest `size` events that have happened at the cursor, newest first, for the log. */
export function eventsUpTo(
  events: readonly ShokubaEvent[],
  cursor: number,
  size = 60,
): ShokubaEvent[] {
  const end = Math.min(Math.max(cursor, 0), events.length)
  return events.slice(Math.max(0, end - size), end).reverse()
}

/** A conversation's subject as recorded by the cursor, or null; never what it was called later. */
export function subjectAt(
  events: readonly ShokubaEvent[],
  cursor: number,
  conversationId: string,
): string | null {
  for (let index = Math.min(cursor, events.length) - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'conversation.created' && event.payload.conversationId === conversationId) {
      return event.payload.subject
    }
  }
  return null
}
