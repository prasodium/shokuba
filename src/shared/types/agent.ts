/**
 * What the agent *process* is actually doing.
 *
 * This is runtime truth, derived from real events. It is deliberately separate from
 * the office simulation's visual activities (walking, coffee, sleeping...), which are
 * layered on top and never feed back into the runtime.
 */
export const RUNTIME_STATES = [
  'offline',
  'starting',
  'idle',
  'thinking',
  'coding',
  'testing',
  'reviewing',
  'researching',
  'waiting',
  'blocked',
  'paused',
  'error',
  'stopped',
] as const

export type RuntimeState = (typeof RUNTIME_STATES)[number]
