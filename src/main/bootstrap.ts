import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase, type Db } from './database/connection'
import { MIGRATIONS } from './database/migrations'
import { migrate } from './database/migrator'
import { AuditLog } from './events/audit'
import { EventBus } from './events/bus'
import { EventLog } from './events/log'
import { EventStore } from './events/store'
import { createLogger, describeError, type Logger } from './logging/logger'
import type { PlatformId } from './platform'

export interface ServicesOptions {
  /** Directory that holds the database. Created if missing. */
  dataDir: string
  version: string
  platform: PlatformId
  logger?: Logger
}

export interface Services {
  dataDir: string
  db: Db
  events: EventStore
  audit: AuditLog
  logger: Logger
  schemaVersion: number
  /** Publishes `app.stopping` and closes the database. Safe to call once. */
  close(): void
}

/**
 * Wire up everything that does not depend on Electron: database, migrations, event
 * store and audit log. Kept separate from `index.ts` so it can be tested (and reused by
 * a future headless mode) without launching a window.
 */
export function createServices(options: ServicesOptions): Services {
  const logger = options.logger ?? createLogger()
  mkdirSync(options.dataDir, { recursive: true })

  const db = openDatabase(join(options.dataDir, 'shokuba.sqlite'))
  let schemaVersion: number
  try {
    const result = migrate(db, MIGRATIONS)
    schemaVersion = result.version
    if (result.applied.length > 0) logger.info('database.migrated', { applied: result.applied })
  } catch (error) {
    db.close()
    throw error
  }

  const bus = new EventBus((error, event) =>
    logger.error('event.listener.failed', {
      eventType: event.type,
      seq: event.seq,
      ...describeError(error),
    }),
  )
  const events = new EventStore(new EventLog(db), bus)
  const audit = new AuditLog(db)

  events.publish({
    type: 'app.started',
    source: 'system',
    payload: { version: options.version, platform: options.platform },
  })
  audit.record({
    actor: 'system',
    action: 'app.start',
    detail: { version: options.version, platform: options.platform, schemaVersion },
  })

  let closed = false
  return {
    dataDir: options.dataDir,
    db,
    events,
    audit,
    logger,
    schemaVersion,
    close() {
      if (closed) return
      closed = true
      try {
        events.publish({ type: 'app.stopping', source: 'system', payload: {} })
      } finally {
        db.close()
      }
    },
  }
}
