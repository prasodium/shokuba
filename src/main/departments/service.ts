import { randomUUID } from 'node:crypto'
import {
  DepartmentInputSchema,
  DepartmentUpdateSchema,
  type Department,
  type DepartmentInput,
  type DepartmentUpdate,
} from '@shared/departments'
import type { Db } from '../database/connection'
import type { EventStore } from '../events/store'

export type DepartmentErrorCode = 'invalid' | 'not-found'

export class DepartmentError extends Error {
  constructor(
    readonly code: DepartmentErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'DepartmentError'
  }
}

interface Row {
  id: string
  name: string
  color: string
  created_at: string
  updated_at: string
}

const COLUMNS: Record<keyof DepartmentUpdate, string> = { name: 'name', color: 'color' }

export interface DepartmentServiceDeps {
  db: Db
  events: EventStore
  now?: () => Date
  newId?: () => string
}

/**
 * Departments group people: where they sit in the office, and how the roster lists them. Removing
 * one takes its people out of it and removes nobody. It is not a team: who reports to whom is a
 * different fact and is not touched here.
 */
export class DepartmentService {
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(private readonly deps: DepartmentServiceDeps) {
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? randomUUID
  }

  /** Every department that has not been removed, in the order they were made. */
  list(): Department[] {
    const rows = this.deps.db
      .prepare('SELECT * FROM departments WHERE archived_at IS NULL ORDER BY created_at, rowid')
      .all() as Row[]
    return rows.map(toDepartment)
  }

  get(id: string): Department | undefined {
    const row = this.deps.db
      .prepare('SELECT * FROM departments WHERE id = ? AND archived_at IS NULL')
      .get(id) as Row | undefined
    return row && toDepartment(row)
  }

  create(raw: DepartmentInput): Department {
    const parsed = DepartmentInputSchema.safeParse(raw)
    if (!parsed.success) throw new DepartmentError('invalid', firstIssue(parsed.error))
    const input = parsed.data
    this.requireFreeName(input.name)

    const id = this.newId()
    const ts = this.now().toISOString()
    this.deps.db
      .prepare(
        `INSERT INTO departments (id, name, color, created_at, updated_at)
         VALUES (@id, @name, @color, @ts, @ts)`,
      )
      .run({ id, name: input.name, color: input.color, ts })
    this.deps.events.publish({
      type: 'department.created',
      source: 'user',
      payload: { departmentId: id },
    })
    return this.mustGet(id)
  }

  update(id: string, raw: DepartmentUpdate): Department {
    const parsed = DepartmentUpdateSchema.safeParse(raw)
    if (!parsed.success) throw new DepartmentError('invalid', firstIssue(parsed.error))
    const patch = parsed.data
    const existing = this.get(id)
    if (!existing) throw new DepartmentError('not-found', 'No such department')

    const changed = (Object.keys(patch) as Array<keyof DepartmentUpdate>).filter(
      (key) => patch[key] !== undefined && patch[key] !== existing[key],
    )
    if (changed.length === 0) return existing
    if (changed.includes('name') && patch.name !== undefined) this.requireFreeName(patch.name, id)

    const params: Record<string, string> = { id, ts: this.now().toISOString() }
    const sets = changed.map((key) => {
      params[key] = patch[key] as string
      return `${COLUMNS[key]} = @${key}`
    })
    this.deps.db
      .prepare(`UPDATE departments SET ${sets.join(', ')}, updated_at = @ts WHERE id = @id`)
      .run(params)
    this.deps.events.publish({
      type: 'department.updated',
      source: 'user',
      payload: { departmentId: id, fields: changed },
    })
    return this.mustGet(id)
  }

  /** Remove a department. Its people stay, with no department. */
  archive(id: string): void {
    const existing = this.get(id)
    if (!existing) throw new DepartmentError('not-found', 'No such department')
    const ts = this.now().toISOString()
    const members = this.deps.db
      .prepare(
        'SELECT id FROM employees WHERE department_id = ? AND archived_at IS NULL ORDER BY created_at, rowid',
      )
      .all(id) as Array<{ id: string }>

    this.deps.db.transaction(() => {
      this.deps.db
        .prepare(
          'UPDATE employees SET department_id = NULL, updated_at = @ts WHERE department_id = @id',
        )
        .run({ id, ts })
      this.deps.db
        .prepare('UPDATE departments SET archived_at = @ts, updated_at = @ts WHERE id = @id')
        .run({ id, ts })
    })()

    for (const member of members) {
      this.deps.events.publish({
        type: 'employee.updated',
        source: 'user',
        actorId: member.id,
        payload: { employeeId: member.id, fields: ['departmentId'] },
      })
    }
    this.deps.events.publish({
      type: 'department.updated',
      source: 'user',
      payload: { departmentId: id, fields: ['archived'] },
    })
  }

  /** How many people are in each department (those not removed), by department id. */
  headcounts(): Record<string, number> {
    const rows = this.deps.db
      .prepare(
        `SELECT department_id AS id, COUNT(*) AS n FROM employees
         WHERE department_id IS NOT NULL AND archived_at IS NULL GROUP BY department_id`,
      )
      .all() as Array<{ id: string; n: number }>
    return Object.fromEntries(rows.map((row) => [row.id, row.n]))
  }

  private taken(name: string, exceptId?: string): boolean {
    const wanted = name.trim().toLowerCase()
    return this.list().some((d) => d.id !== exceptId && d.name.toLowerCase() === wanted)
  }

  private requireFreeName(name: string, exceptId?: string): void {
    if (this.taken(name, exceptId)) {
      throw new DepartmentError('invalid', `There is already a department called "${name}"`)
    }
  }

  private mustGet(id: string): Department {
    const department = this.get(id)
    if (!department) throw new DepartmentError('not-found', 'No such department')
    return department
  }
}

function firstIssue(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  const issue = error.issues[0]
  if (!issue) return 'Invalid department'
  const field = issue.path.map(String).join('.')
  return field ? `${field}: ${issue.message}` : issue.message
}

function toDepartment(row: Row): Department {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
