import type { ShokubaEvent } from '@shared/events/schema'

/**
 * The sequence number of the newest `workspace.changed` event for a task or a mission, or 0 if
 * there is none. A view that reads a task's changes uses it to read again when its folder is
 * made, saved, merged or removed, which can happen long after the task itself last changed.
 */
export function latestWorkspaceSeq(
  events: readonly ShokubaEvent[],
  match: { taskId: string } | { missionId: string },
): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'workspace.changed') continue
    const same =
      'taskId' in match
        ? event.payload.taskId === match.taskId
        : event.payload.missionId === match.missionId
    if (same) return event.seq
  }
  return 0
}

/** The same for a task's runs of checks: read again when one starts, steps along, or finishes. */
export function latestVerificationSeq(events: readonly ShokubaEvent[], taskId: string): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'verification.changed' && event.payload.taskId === taskId) return event.seq
  }
  return 0
}

/** The same for a task's reviews: read again when one is asked for, starts, or is handed in. */
export function latestReviewSeq(events: readonly ShokubaEvent[], taskId: string): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'review.changed' && event.payload.taskId === taskId) return event.seq
  }
  return 0
}
