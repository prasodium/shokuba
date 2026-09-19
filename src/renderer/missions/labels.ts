import type { MissionStatus, TaskStatus } from '@shared/missions'

/** Plain-language names for statuses. "Needs review" is the one that asks something of a person. */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'Waiting',
  ready: 'Ready',
  in_progress: 'In progress',
  submitted: 'Needs review',
  changes_requested: 'Sent back',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
}

export const MISSION_STATUS_LABELS: Record<MissionStatus, string> = {
  draft: 'Draft',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

/** Shortened for a graph node. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
