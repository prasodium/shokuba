import { z } from 'zod'
import { RUNTIME_STATES } from '../types/agent'

/**
 * Where an event's claim comes from. The UI uses this to label inferred data honestly.
 *  - reported:  the agent/CLI told us directly (hooks, structured output)
 *  - inferred:  we deduced it (e.g. from terminal output)
 *  - simulated: produced by demo mode or the office simulation
 *  - system:    emitted by Shokuba itself
 *  - user:      caused by a human action
 */
export const EventSourceSchema = z.enum(['reported', 'inferred', 'simulated', 'system', 'user'])
export type EventSource = z.infer<typeof EventSourceSchema>

export const PLATFORM_IDS = ['darwin', 'win32', 'linux'] as const

const id = z.string().min(1).max(200)

const envelope = {
  source: EventSourceSchema,
  actorId: id.optional(),
  targetId: id.optional(),
  missionId: id.optional(),
  taskId: id.optional(),
  correlationId: id.optional(),
  causationId: id.optional(),
}

function event<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.strictObject({ type: z.literal(type), payload, ...envelope })
}

/**
 * Every event Shokuba can publish. Add a member here (with a real payload schema)
 * when a feature starts emitting it — not before.
 */
export const EventInputSchema = z.discriminatedUnion('type', [
  event('app.started', z.strictObject({ version: z.string(), platform: z.enum(PLATFORM_IDS) })),
  event('app.stopping', z.strictObject({})),

  event('agent.created', z.strictObject({ employeeId: id, providerId: id })),
  event(
    'agent.started',
    z.strictObject({ employeeId: id, pid: z.number().int().positive().optional() }),
  ),
  event('agent.ready', z.strictObject({ employeeId: id })),
  event(
    'agent.state.changed',
    z.strictObject({
      employeeId: id,
      from: z.enum(RUNTIME_STATES),
      to: z.enum(RUNTIME_STATES),
      reason: z.string().max(500).optional(),
    }),
  ),
  event(
    'agent.stopped',
    z.strictObject({
      employeeId: id,
      exitCode: z.number().int().nullable(),
      signal: z.string().max(32).nullable(),
    }),
  ),
  event(
    'agent.error',
    z.strictObject({ employeeId: id, code: z.string().max(100), message: z.string().max(2000) }),
  ),

  // A turn is one prompt-to-answer cycle of the agent. Prompt and answer text are
  // deliberately not recorded: the office only needs to know *that* work is happening.
  event('agent.turn.started', z.strictObject({ employeeId: id })),
  event('agent.turn.finished', z.strictObject({ employeeId: id })),
  event(
    'agent.tool.started',
    z.strictObject({
      employeeId: id,
      toolName: z.string().min(1).max(100),
      /** Short human-readable description, e.g. "Edit src/app.ts". Redacted before storage. */
      summary: z.string().max(300),
      toolUseId: z.string().max(200).optional(),
    }),
  ),
  event(
    'agent.tool.finished',
    z.strictObject({
      employeeId: id,
      toolName: z.string().min(1).max(100),
      ok: z.boolean(),
      durationMs: z.number().int().min(0).optional(),
      toolUseId: z.string().max(200).optional(),
    }),
  ),
  /** The agent is blocked on a human (a permission prompt, a question). */
  event(
    'agent.attention',
    z.strictObject({
      employeeId: id,
      reason: z.enum(['permission', 'input', 'other']),
      message: z.string().max(300),
    }),
  ),

  event(
    'employee.updated',
    z.strictObject({ employeeId: id, fields: z.array(z.string().max(50)) }),
  ),
])

/** An event as a publisher supplies it. */
export type EventInput = z.infer<typeof EventInputSchema>

/** Fields the log assigns when an event is persisted. */
export interface EventMeta {
  /** Monotonic, gap-free ordering key. Never reused. */
  seq: number
  id: string
  /** ISO-8601 UTC timestamp. */
  ts: string
}

/** A persisted event. */
export type ShokubaEvent = EventInput & EventMeta

export type EventType = EventInput['type']
export type EventOfType<T extends EventType> = Extract<ShokubaEvent, { type: T }>
