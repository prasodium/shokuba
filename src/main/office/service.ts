import {
  OfficeSettingsSchema,
  changedParts,
  parseOfficeSettings,
  type OfficeSettings,
} from '@shared/office'
import type { Db } from '../database/connection'
import type { EventStore } from '../events/store'

export class OfficeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OfficeError'
  }
}

export interface OfficeServiceDeps {
  db: Db
  events: EventStore
  now?: () => Date
}

/**
 * How the office is dressed: its name, floors, walls, windows, plants and the names of the shared
 * places. There is one office, so one row. Saving replaces the whole thing, validated; reading it
 * never fails (anything that cannot be understood is the office as it has always looked).
 */
export class OfficeService {
  private readonly now: () => Date

  constructor(private readonly deps: OfficeServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  get(): OfficeSettings {
    const row = this.deps.db.prepare('SELECT data FROM office_settings WHERE id = 1').get() as
      { data: string } | undefined
    return parseOfficeSettings(row?.data)
  }

  /** Replace the settings. Nothing is recorded, or changed, if nothing would be different. */
  save(raw: unknown): OfficeSettings {
    const parsed = OfficeSettingsSchema.safeParse(raw)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const field = issue?.path.map(String).join('.')
      throw new OfficeError(
        issue ? (field ? `${field}: ${issue.message}` : issue.message) : 'Invalid office settings',
      )
    }
    const next = parsed.data
    const current = this.get()
    const fields = changedParts(current, next)
    if (fields.length === 0) return current

    this.deps.db
      .prepare(
        `INSERT INTO office_settings (id, data, updated_at) VALUES (1, @data, @ts)
         ON CONFLICT (id) DO UPDATE SET data = @data, updated_at = @ts`,
      )
      .run({ data: JSON.stringify(next), ts: this.now().toISOString() })
    this.deps.events.publish({ type: 'office.updated', source: 'user', payload: { fields } })
    return next
  }
}
