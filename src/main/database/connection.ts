import Database from 'better-sqlite3'

export type Db = Database.Database

/**
 * Open (creating if needed) the application database.
 *  - WAL: readers never block the writer, and a crash cannot corrupt committed data.
 *  - foreign_keys: SQLite ignores foreign keys unless asked, per connection.
 *  - busy_timeout: wait briefly instead of failing when another connection holds the lock.
 */
export function openDatabase(file: string): Db {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  return db
}
