import { z } from 'zod'

/**
 * How far an agent has been restrained, least to most:
 *  - normal:    nothing
 *  - warning:   a visible flag only
 *  - constrain: no new tasks, no agent-to-agent messages, and the call that is being repeated
 *               (or further edits, for a runaway edit count) is denied
 *  - pause:     every tool call is denied except the hand-back tools, and the running turn is
 *               interrupted
 *  - stop:      the process is ended (only ever by a person)
 */
export const BREAKER_LEVELS = ['normal', 'warning', 'constrain', 'pause', 'stop'] as const
export type BreakerLevel = (typeof BREAKER_LEVELS)[number]

/** What tripped it. `manual` is a person pressing Pause or Stop. */
export const BREAKER_RULES = [
  'repeated-call',
  'failed-calls',
  'failed-turns',
  'file-changes',
  'long-turn',
  'halted-conversations',
  'manual',
  'restarted',
] as const
export type BreakerRule = (typeof BREAKER_RULES)[number]

export function levelRank(level: BreakerLevel): number {
  return BREAKER_LEVELS.indexOf(level)
}

/** Things a person can do to an agent's breaker. */
export const BREAKER_ACTIONS = ['reset', 'pause', 'stop'] as const
export type BreakerAction = (typeof BREAKER_ACTIONS)[number]

export const BreakerActionRequestSchema = z.strictObject({
  employeeId: z.string().min(1).max(200),
  action: z.enum(BREAKER_ACTIONS),
})

/** What the breaker knows about one agent, as the UI shows it. */
export interface BreakerState {
  level: BreakerLevel
  rule: BreakerRule | null
  /** A sentence saying what happened, e.g. "the same call, Run npm test, 8 times in a row". */
  detail: string | null
}
