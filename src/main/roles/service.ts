import { randomUUID } from 'node:crypto'
import {
  ROLE_TEMPLATES,
  RoleInputSchema,
  RoleUpdateSchema,
  builtinRoleId,
  type Role,
  type RoleInput,
  type RoleUpdate,
} from '@shared/roles'
import type { PermissionMode } from '@shared/employees'
import type { Db } from '../database/connection'
import type { EventStore } from '../events/store'

export type RoleErrorCode = 'invalid' | 'not-found' | 'builtin' | 'not-builtin'

export class RoleError extends Error {
  constructor(
    readonly code: RoleErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'RoleError'
  }
}

interface Row {
  id: string
  label: string
  is_manager: number
  instructions: string
  permission_mode: string
  builtin_id: string | null
  created_at: string
  updated_at: string
}

const COLUMNS: Record<keyof RoleUpdate, string> = {
  label: 'label',
  isManager: 'is_manager',
  instructions: 'instructions',
  permissionMode: 'permission_mode',
}

/** The longest a label can be (it is the same rule as an employee's role). */
const MAX_LABEL = 60

export interface RoleServiceDeps {
  db: Db
  events: EventStore
  now?: () => Date
  newId?: () => string
}

/**
 * Roles are starting points for hiring, and can be edited. Shokuba's own four are here too: they
 * can be edited and reset to the originals kept in the code, but not removed. Nothing links a role
 * to the people hired from it (an employee keeps their own copy), so nothing here ever changes an
 * employee.
 */
export class RoleService {
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(private readonly deps: RoleServiceDeps) {
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? randomUUID
    this.ensureBuiltins()
  }

  /**
   * Put in any of Shokuba's own roles that are missing. It never touches one that is there, so an
   * edited built-in stays edited, and it is not an event: it is housekeeping, not something done.
   */
  private ensureBuiltins(): void {
    const ts = this.now().toISOString()
    const insert = this.deps.db.prepare(
      `INSERT OR IGNORE INTO roles
         (id, label, is_manager, instructions, permission_mode, builtin_id, created_at, updated_at)
       VALUES (@id, @label, @isManager, @instructions, 'default', @builtin, @ts, @ts)`,
    )
    for (const template of ROLE_TEMPLATES) {
      insert.run({
        id: builtinRoleId(template.id),
        label: template.role,
        isManager: template.isManager ? 1 : 0,
        instructions: template.instructions,
        builtin: template.id,
        ts,
      })
    }
  }

  /** Every role that has not been removed: Shokuba's own first, then yours in the order made. */
  list(): Role[] {
    const rows = this.deps.db
      .prepare(
        `SELECT * FROM roles WHERE archived_at IS NULL
         ORDER BY builtin_id IS NULL, created_at, rowid`,
      )
      .all() as Row[]
    return rows.map(toRole)
  }

  get(id: string): Role | undefined {
    const row = this.deps.db
      .prepare('SELECT * FROM roles WHERE id = ? AND archived_at IS NULL')
      .get(id) as Row | undefined
    return row && toRole(row)
  }

  create(raw: RoleInput): Role {
    const parsed = RoleInputSchema.safeParse(raw)
    if (!parsed.success) throw new RoleError('invalid', firstIssue(parsed.error))
    const input = parsed.data
    this.requireFreeLabel(input.label)

    const id = this.newId()
    const ts = this.now().toISOString()
    this.deps.db
      .prepare(
        `INSERT INTO roles
           (id, label, is_manager, instructions, permission_mode, builtin_id, created_at, updated_at)
         VALUES (@id, @label, @isManager, @instructions, @permissionMode, NULL, @ts, @ts)`,
      )
      .run({
        id,
        label: input.label,
        isManager: input.isManager ? 1 : 0,
        instructions: input.instructions,
        permissionMode: input.permissionMode,
        ts,
      })
    this.deps.events.publish({ type: 'role.created', source: 'user', payload: { roleId: id } })
    return this.mustGet(id)
  }

  update(id: string, raw: RoleUpdate): Role {
    const parsed = RoleUpdateSchema.safeParse(raw)
    if (!parsed.success) throw new RoleError('invalid', firstIssue(parsed.error))
    const patch = parsed.data
    const existing = this.get(id)
    if (!existing) throw new RoleError('not-found', 'No such role')

    // Only what would really change counts: saving a form that changed nothing is not an edit.
    const changed = (Object.keys(patch) as Array<keyof RoleUpdate>).filter(
      (key) => patch[key] !== undefined && patch[key] !== existing[key],
    )
    if (changed.length === 0) return existing
    if (patch.label !== undefined && changed.includes('label')) {
      this.requireFreeLabel(patch.label, id)
    }

    this.write(id, patch, changed)
    this.deps.events.publish({
      type: 'role.updated',
      source: 'user',
      payload: { roleId: id, fields: changed },
    })
    return this.mustGet(id)
  }

  /** A new role of your own, made from this one, with a label that is not taken. */
  duplicate(id: string): Role {
    const original = this.get(id)
    if (!original) throw new RoleError('not-found', 'No such role')
    return this.create({
      label: this.copyLabel(original.label),
      isManager: original.isManager,
      instructions: original.instructions,
      permissionMode: original.permissionMode,
    })
  }

  /** Remove one of your own roles. Shokuba's own cannot be removed, only edited or reset. */
  archive(id: string): void {
    const existing = this.get(id)
    if (!existing) throw new RoleError('not-found', 'No such role')
    if (existing.builtin) {
      throw new RoleError(
        'builtin',
        `${existing.label} is one of Shokuba's own roles: edit it, or reset it to the original, but it cannot be removed`,
      )
    }
    const ts = this.now().toISOString()
    this.deps.db
      .prepare('UPDATE roles SET archived_at = @ts, updated_at = @ts WHERE id = @id')
      .run({ id, ts })
    this.deps.events.publish({
      type: 'role.updated',
      source: 'user',
      payload: { roleId: id, fields: ['archived'] },
    })
  }

  /** Put one of Shokuba's own roles back to what Shokuba wrote. */
  reset(id: string): Role {
    const existing = this.get(id)
    if (!existing) throw new RoleError('not-found', 'No such role')
    const row = this.deps.db.prepare('SELECT builtin_id FROM roles WHERE id = ?').get(id) as {
      builtin_id: string | null
    }
    const template = ROLE_TEMPLATES.find((t) => t.id === row.builtin_id)
    if (!template) {
      throw new RoleError('not-builtin', `${existing.label} is your own role: there is no original`)
    }
    const original: Required<RoleUpdate> = {
      label: template.role,
      isManager: template.isManager,
      instructions: template.instructions,
      permissionMode: 'default',
    }
    const changed = (Object.keys(original) as Array<keyof RoleUpdate>).filter(
      (key) => original[key] !== existing[key],
    )
    if (changed.length === 0) return existing
    // Another role may have taken the original label since; two roles never share one.
    if (changed.includes('label')) this.requireFreeLabel(original.label, id)
    this.write(id, original, changed)
    this.deps.events.publish({
      type: 'role.updated',
      source: 'user',
      payload: { roleId: id, fields: ['reset'] },
    })
    return this.mustGet(id)
  }

  private write(id: string, values: RoleUpdate, keys: Array<keyof RoleUpdate>): void {
    const params: Record<string, string | number> = { id, ts: this.now().toISOString() }
    const sets = keys.map((key) => {
      const value = values[key]
      params[key] = typeof value === 'boolean' ? (value ? 1 : 0) : (value as string)
      return `${COLUMNS[key]} = @${key}`
    })
    this.deps.db
      .prepare(`UPDATE roles SET ${sets.join(', ')}, updated_at = @ts WHERE id = @id`)
      .run(params)
  }

  private taken(label: string, exceptId?: string): boolean {
    const wanted = label.trim().toLowerCase()
    return this.list().some((role) => role.id !== exceptId && role.label.toLowerCase() === wanted)
  }

  private requireFreeLabel(label: string, exceptId?: string): void {
    if (this.taken(label, exceptId)) {
      throw new RoleError('invalid', `There is already a role called "${label}"`)
    }
  }

  /**
   * The label for a copy of `label`: it with "(copy)", or "(copy 2)" and so on, whichever is not
   * taken. A copy of a copy is a copy of the original, and the label is cut, before the suffix, to fit.
   */
  private copyLabel(label: string): string {
    const stem = label.replace(/ \(copy( \d+)?\)$/, '')
    const fit = (suffix: string): string =>
      `${stem.slice(0, Math.max(1, MAX_LABEL - suffix.length))}${suffix}`
    const first = fit(' (copy)')
    if (!this.taken(first)) return first
    for (let n = 2; ; n += 1) {
      const candidate = fit(` (copy ${n})`)
      if (!this.taken(candidate)) return candidate
    }
  }

  private mustGet(id: string): Role {
    const role = this.get(id)
    if (!role) throw new RoleError('not-found', 'No such role')
    return role
  }
}

function firstIssue(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  const issue = error.issues[0]
  if (!issue) return 'Invalid role'
  const field = issue.path.map(String).join('.')
  return field ? `${field}: ${issue.message}` : issue.message
}

function toRole(row: Row): Role {
  return {
    id: row.id,
    label: row.label,
    isManager: row.is_manager === 1,
    instructions: row.instructions,
    permissionMode: row.permission_mode as PermissionMode,
    builtin: row.builtin_id !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
