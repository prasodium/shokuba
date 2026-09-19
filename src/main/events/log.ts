import { randomUUID } from 'node:crypto'
import {
  EventInputSchema,
  type EventInput,
  type EventType,
  type ShokubaEvent,
} from '@shared/events/schema'
import type { Db } from '../database/connection'

export class CorruptEventError extends Error {
  constructor(
    readonly seq: number,
    readonly eventType: string,
    detail: string,
  ) {
    super(`Stored event #${seq} ("${eventType}") does not match its schema: ${detail}`)
    this.name = 'CorruptEventError'
  }
}

export interface ListOptions {
  /** Return events with seq strictly greater than this. Default 0 (from the start). */
  afterSeq?: number
  limit?: number
  type?: EventType
  actorId?: string
  taskId?: string
  missionId?: string
}

interface Row {
  seq: number
  id: string
  ts: string
  type: string
  source: string
  actor_id: string | null
  target_id: string | null
  mission_id: string | null
  task_id: string | null
  correlation_id: string | null
  causation_id: string | null
  payload: string
}

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000

/** Append-only persistence for events. Assigns `seq`, `id` and `ts`. */
export class EventLog {
  private readonly insert

  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {
    this.insert = db.prepare(`
      INSERT INTO agent_events
        (id, ts, type, source, actor_id, target_id, mission_id, task_id, correlation_id, causation_id, payload)
      VALUES
        (@id, @ts, @type, @source, @actorId, @targetId, @missionId, @taskId, @correlationId, @causationId, @payload)
    `)
  }

  /** Persist an already-validated event. Prefer EventStore.publish, which validates first. */
  append(input: EventInput): ShokubaEvent {
    const id = this.newId()
    const ts = this.now().toISOString()
    const info = this.insert.run({
      id,
      ts,
      type: input.type,
      source: input.source,
      actorId: input.actorId ?? null,
      targetId: input.targetId ?? null,
      missionId: input.missionId ?? null,
      taskId: input.taskId ?? null,
      correlationId: input.correlationId ?? null,
      causationId: input.causationId ?? null,
      payload: JSON.stringify(input.payload),
    })
    return { ...input, seq: Number(info.lastInsertRowid), id, ts }
  }

  list(options: ListOptions = {}): ShokubaEvent[] {
    const where: string[] = ['seq > @afterSeq']
    const params: Record<string, string | number> = {
      afterSeq: options.afterSeq ?? 0,
      limit: Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT),
    }
    if (options.type) {
      where.push('type = @type')
      params['type'] = options.type
    }
    if (options.actorId) {
      where.push('actor_id = @actorId')
      params['actorId'] = options.actorId
    }
    if (options.taskId) {
      where.push('task_id = @taskId')
      params['taskId'] = options.taskId
    }
    if (options.missionId) {
      where.push('mission_id = @missionId')
      params['missionId'] = options.missionId
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM agent_events WHERE ${where.join(' AND ')} ORDER BY seq ASC LIMIT @limit`,
      )
      .all(params) as Row[]
    return rows.map(toEvent)
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM agent_events').get() as { n: number }).n
  }

  latestSeq(): number {
    return (
      this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM agent_events').get() as { n: number }
    ).n
  }
}

/** Rows come from disk, so they are validated like any other untrusted input. */
function toEvent(row: Row): ShokubaEvent {
  let payload: unknown
  try {
    payload = JSON.parse(row.payload)
  } catch {
    throw new CorruptEventError(row.seq, row.type, 'payload is not valid JSON')
  }

  const candidate = {
    type: row.type,
    source: row.source,
    payload,
    ...(row.actor_id !== null && { actorId: row.actor_id }),
    ...(row.target_id !== null && { targetId: row.target_id }),
    ...(row.mission_id !== null && { missionId: row.mission_id }),
    ...(row.task_id !== null && { taskId: row.task_id }),
    ...(row.correlation_id !== null && { correlationId: row.correlation_id }),
    ...(row.causation_id !== null && { causationId: row.causation_id }),
  }

  const parsed = EventInputSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new CorruptEventError(row.seq, row.type, parsed.error.issues[0]?.message ?? 'invalid')
  }
  return { ...parsed.data, seq: row.seq, id: row.id, ts: row.ts }
}
