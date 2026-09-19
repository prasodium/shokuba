import { EventInputSchema, type EventInput, type ShokubaEvent } from '@shared/events/schema'
import { redactDeep } from '../security/redact'
import type { EventBus } from './bus'
import type { EventLog } from './log'

export class InvalidEventError extends Error {
  constructor(readonly issues: string[]) {
    super(`Refusing to publish an invalid event: ${issues.join('; ')}`)
    this.name = 'InvalidEventError'
  }
}

/**
 * The one way events enter the system:
 *
 *   redact  ->  validate  ->  persist  ->  broadcast
 *
 * Persist-first means a subscriber can never see an event that is not in the log, so
 * replay and the live office always agree. If persisting throws, nothing is broadcast.
 */
export class EventStore {
  constructor(
    readonly log: EventLog,
    readonly bus: EventBus,
  ) {}

  publish(input: EventInput): ShokubaEvent {
    // Redact first, then validate: what is stored is exactly what passed validation.
    const parsed = EventInputSchema.safeParse(redactDeep(input))
    if (!parsed.success) {
      throw new InvalidEventError(
        parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      )
    }

    const event = this.log.append(parsed.data)
    this.bus.emit(event)
    return event
  }
}
