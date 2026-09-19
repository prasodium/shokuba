import { z } from 'zod'
import { BREAKER_LEVELS, BREAKER_RULES } from '../breaker'
import { CONVERSATION_STATUSES, MESSAGE_KINDS } from '../messages'
import { MISSION_STATUSES, TASK_STATUSES } from '../missions'
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

  // Missions and tasks. `missionId` / `taskId` in the envelope let the log be filtered by either.
  event('mission.created', z.strictObject({ missionId: id, title: z.string().max(200) })),
  event('mission.updated', z.strictObject({ missionId: id, fields: z.array(z.string().max(50)) })),
  event(
    'mission.status.changed',
    z.strictObject({
      missionId: id,
      from: z.enum(MISSION_STATUSES),
      to: z.enum(MISSION_STATUSES),
      reason: z.string().max(500).optional(),
    }),
  ),
  event('task.created', z.strictObject({ taskId: id, missionId: id, title: z.string().max(200) })),
  event(
    'task.updated',
    z.strictObject({ taskId: id, missionId: id, fields: z.array(z.string().max(50)) }),
  ),
  event(
    'task.status.changed',
    z.strictObject({
      taskId: id,
      missionId: id,
      from: z.enum(TASK_STATUSES),
      to: z.enum(TASK_STATUSES),
      reason: z.string().max(500).optional(),
    }),
  ),
  event('task.assigned', z.strictObject({ taskId: id, missionId: id, employeeId: id.nullable() })),
  /** A task was handed to an agent's terminal. */
  event(
    'task.dispatched',
    z.strictObject({
      taskId: id,
      missionId: id,
      employeeId: id,
      attempt: z.number().int().min(1),
    }),
  ),

  // Messages and conversations. Bodies are never in events; they live in the messages table.
  event(
    'conversation.created',
    z.strictObject({ conversationId: id, subject: z.string().max(200) }),
  ),
  event(
    'conversation.status.changed',
    z.strictObject({
      conversationId: id,
      from: z.enum(CONVERSATION_STATUSES),
      to: z.enum(CONVERSATION_STATUSES),
      reason: z.string().max(500).optional(),
    }),
  ),
  event(
    'message.sent',
    z.strictObject({
      messageId: id,
      conversationId: id,
      fromId: id,
      toId: id,
      kind: z.enum(MESSAGE_KINDS),
      hop: z.number().int().min(1),
    }),
  ),
  event(
    'message.delivered',
    z.strictObject({
      messageId: id,
      conversationId: id,
      toId: id,
      via: z.enum(['continuation', 'paste']),
    }),
  ),
  event(
    'message.held',
    z.strictObject({ messageId: id, conversationId: id, reason: z.string().max(300) }),
  ),
  event('message.read', z.strictObject({ messageId: id, conversationId: id })),

  // The circuit breaker: how far an agent has been restrained, and each call it refused.
  event(
    'breaker.state.changed',
    z.strictObject({
      employeeId: id,
      from: z.enum(BREAKER_LEVELS),
      to: z.enum(BREAKER_LEVELS),
      rule: z.enum(BREAKER_RULES),
      detail: z.string().max(300).optional(),
    }),
  ),
  event(
    'breaker.denied',
    z.strictObject({
      employeeId: id,
      toolName: z.string().min(1).max(100),
      reason: z.string().max(500),
    }),
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
