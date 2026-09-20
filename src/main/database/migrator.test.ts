import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from './connection'
import { MIGRATIONS } from './migrations'
import { MigrationError, migrate, type Migration } from './migrator'

const open: Db[] = []
const memory = (): Db => {
  const db = openDatabase(':memory:')
  open.push(db)
  return db
}
afterEach(() => {
  while (open.length > 0) open.pop()?.close()
})

const create = (id: number, table: string): Migration => ({
  id,
  name: `create_${table}`,
  sql: `CREATE TABLE ${table} (x INTEGER)`,
})

const tables = (db: Db): string[] =>
  (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as {
      name: string
    }[]
  ).map((row) => row.name)

describe('migrate', () => {
  it('applies every migration to a fresh database, in order', () => {
    const db = memory()
    const result = migrate(db, [create(1, 'a'), create(2, 'b')])
    expect(result).toEqual({ version: 2, applied: [1, 2] })
    expect(tables(db)).toEqual(expect.arrayContaining(['a', 'b', 'schema_migrations']))
  })

  it('is idempotent: a second run applies nothing', () => {
    const db = memory()
    const migrations = [create(1, 'a'), create(2, 'b')]
    migrate(db, migrations)
    expect(migrate(db, migrations)).toEqual({ version: 2, applied: [] })
  })

  it('applies only the new migrations when the app upgrades', () => {
    const db = memory()
    migrate(db, [create(1, 'a')])
    expect(migrate(db, [create(1, 'a'), create(2, 'b')])).toEqual({ version: 2, applied: [2] })
  })

  it('rolls a failing migration back completely and leaves earlier ones applied', () => {
    const db = memory()
    const broken: Migration = {
      id: 2,
      name: 'broken',
      sql: 'CREATE TABLE half (x INTEGER); THIS IS NOT SQL;',
    }
    expect(() => migrate(db, [create(1, 'a'), broken])).toThrow(
      /Migration 2 \("broken"\) failed and was rolled back/,
    )
    expect(tables(db)).toContain('a')
    expect(tables(db)).not.toContain('half')
    const ids = db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]
    expect(ids).toEqual([{ id: 1 }])
  })

  it('refuses when an already-applied migration was edited', () => {
    const db = memory()
    migrate(db, [create(1, 'a')])
    const edited: Migration = { id: 1, name: 'create_a', sql: 'CREATE TABLE a (x INTEGER, y TEXT)' }
    expect(() => migrate(db, [edited])).toThrow(/modified after it was applied/)
  })

  it('refuses a database created by a newer version of the app', () => {
    const db = memory()
    migrate(db, [create(1, 'a'), create(2, 'b')])
    expect(() => migrate(db, [create(1, 'a')])).toThrow(/newer version/)
  })

  it.each([
    ['a gap', [create(1, 'a'), create(3, 'c')]],
    ['not starting at 1', [create(2, 'b')]],
    ['duplicates', [create(1, 'a'), create(1, 'b')]],
  ])('rejects migration lists with %s', (_name, list) => {
    expect(() => migrate(memory(), list)).toThrow(MigrationError)
  })

  it('reports version 0 for an empty list', () => {
    expect(migrate(memory(), [])).toEqual({ version: 0, applied: [] })
  })
})

describe('the real migration set', () => {
  it('applies cleanly and creates the append-only logs', () => {
    const db = memory()
    const { version } = migrate(db, MIGRATIONS)
    expect(version).toBe(MIGRATIONS.length)
    expect(tables(db)).toEqual(expect.arrayContaining(['agent_events', 'audit_log']))
  })

  it('has strictly sequential ids', () => {
    expect(MIGRATIONS.map((m) => m.id)).toEqual(MIGRATIONS.map((_m, i) => i + 1))
  })

  it.each(['agent_events', 'audit_log'])('%s rejects UPDATE and DELETE', (table) => {
    const db = memory()
    migrate(db, MIGRATIONS)
    if (table === 'agent_events') {
      db.prepare(
        "INSERT INTO agent_events (id, ts, type, source, payload) VALUES ('e1', 't', 'x', 'system', '{}')",
      ).run()
    } else {
      db.prepare("INSERT INTO audit_log (ts, actor, action) VALUES ('t', 'a', 'b')").run()
    }
    expect(() => db.prepare(`UPDATE ${table} SET ts = 'changed'`).run()).toThrow(/append-only/)
    expect(() => db.prepare(`DELETE FROM ${table}`).run()).toThrow(/append-only/)
  })
})

describe('the appearance migration', () => {
  it('gives an employee hired before it the look everyone had, and adds nothing else', () => {
    const db = memory()
    migrate(db, MIGRATIONS.slice(0, 10))
    db.prepare(
      `INSERT INTO employees (id, name, role, provider_id, working_directory, created_at, updated_at)
       VALUES ('e1', 'Ada', 'Engineer', 'mock', '/w', 't', 't')`,
    ).run()
    expect(migrate(db, MIGRATIONS.slice(0, 11)).applied).toEqual([11])
    const row = db.prepare('SELECT appearance FROM employees WHERE id = ?').get('e1') as {
      appearance: string
    }
    expect(JSON.parse(row.appearance)).toEqual({
      skin: 'sand',
      hair: 'black',
      style: 'short',
      accessory: 'none',
    })
  })
})

describe('the roles migration', () => {
  it('makes an empty roles table: Shokuba’s own are put in when the app starts, not here', () => {
    const db = memory()
    migrate(db, MIGRATIONS)
    expect(db.prepare('SELECT COUNT(*) AS n FROM roles').get()).toEqual({ n: 0 })
    const columns = (db.prepare("PRAGMA table_info('roles')").all() as Array<{ name: string }>).map(
      (c) => c.name,
    )
    expect(columns).toEqual([
      'id',
      'label',
      'is_manager',
      'instructions',
      'permission_mode',
      'builtin_id',
      'created_at',
      'updated_at',
      'archived_at',
    ])
  })

  it('refuses a permission mode Shokuba does not offer', () => {
    const db = memory()
    migrate(db, MIGRATIONS)
    expect(() =>
      db
        .prepare(
          `INSERT INTO roles (id, label, permission_mode, created_at, updated_at)
           VALUES ('r', 'x', 'bypassPermissions', 't', 't')`,
        )
        .run(),
    ).toThrow()
  })
})

describe('the departments migration', () => {
  it('adds the table and leaves every employee hired before it with no department', () => {
    const db = memory()
    migrate(db, MIGRATIONS.slice(0, 12))
    db.prepare(
      `INSERT INTO employees (id, name, role, provider_id, working_directory, created_at, updated_at)
       VALUES ('e1', 'Ada', 'Engineer', 'mock', '/w', 't', 't')`,
    ).run()
    expect(migrate(db, MIGRATIONS).applied).toEqual([13])
    expect(db.prepare('SELECT department_id AS d FROM employees WHERE id = ?').get('e1')).toEqual({
      d: null,
    })
    expect(db.prepare('SELECT COUNT(*) AS n FROM departments').get()).toEqual({ n: 0 })
  })

  it('will not let an employee be put in a department that does not exist', () => {
    const db = memory()
    migrate(db, MIGRATIONS)
    db.pragma('foreign_keys = ON')
    expect(() =>
      db
        .prepare(
          `INSERT INTO employees (id, name, role, provider_id, working_directory, department_id, created_at, updated_at)
           VALUES ('e', 'x', 'y', 'mock', '/w', 'nope', 't', 't')`,
        )
        .run(),
    ).toThrow()
  })
})
