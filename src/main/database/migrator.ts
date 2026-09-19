import { createHash } from 'node:crypto'
import type { Db } from './connection'

export interface Migration {
  /** Strictly increasing, starting at 1, no gaps. */
  id: number
  name: string
  sql: string
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MigrationError'
  }
}

export interface MigrationResult {
  /** Highest migration id now applied. */
  version: number
  /** Ids applied by this call (empty when the database was already current). */
  applied: number[]
}

const checksum = (sql: string): string => createHash('sha256').update(sql).digest('hex')

/**
 * Bring the database up to date. Each migration runs in its own transaction, so a
 * failure leaves the schema exactly as it was before that migration.
 *
 * Guards that protect user data:
 *  - a migration that was already applied must not have been edited (checksum);
 *  - a database written by a *newer* app is refused rather than silently downgraded.
 */
export function migrate(db: Db, migrations: readonly Migration[]): MigrationResult {
  assertWellFormed(migrations)

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      checksum   TEXT    NOT NULL,
      applied_at TEXT    NOT NULL
    )
  `)

  const applied = new Map(
    (
      db.prepare('SELECT id, name, checksum FROM schema_migrations ORDER BY id').all() as {
        id: number
        name: string
        checksum: string
      }[]
    ).map((row) => [row.id, row]),
  )

  const known = new Map(migrations.map((m) => [m.id, m]))
  for (const [id, row] of applied) {
    const migration = known.get(id)
    if (!migration) {
      throw new MigrationError(
        `Database has migration ${id} ("${row.name}") that this version of Shokuba does not know about. ` +
          'It was probably created by a newer version; refusing to open it.',
      )
    }
    if (row.checksum !== checksum(migration.sql)) {
      throw new MigrationError(
        `Migration ${id} ("${migration.name}") was modified after it was applied. ` +
          'Add a new migration instead of editing an old one.',
      )
    }
  }

  const insert = db.prepare(
    'INSERT INTO schema_migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
  )
  const justApplied: number[] = []

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue
    const run = db.transaction(() => {
      db.exec(migration.sql)
      insert.run(migration.id, migration.name, checksum(migration.sql), new Date().toISOString())
    })
    try {
      run()
    } catch (cause) {
      throw new MigrationError(
        `Migration ${migration.id} ("${migration.name}") failed and was rolled back: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      )
    }
    justApplied.push(migration.id)
  }

  const last = migrations[migrations.length - 1]
  return { version: last?.id ?? 0, applied: justApplied }
}

function assertWellFormed(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.id !== index + 1) {
      throw new MigrationError(
        `Migration ids must run 1, 2, 3... without gaps; found id ${migration.id} at position ${index + 1}.`,
      )
    }
  })
}
