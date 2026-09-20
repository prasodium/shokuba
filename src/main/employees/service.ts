import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { parseAppearance } from '@shared/appearance'
import {
  EmployeeInputSchema,
  EmployeeUpdateSchema,
  type Employee,
  type EmployeeInput,
  type EmployeeUpdate,
  type PermissionMode,
} from '@shared/employees'
import type { Db } from '../database/connection'
import type { EventStore } from '../events/store'
import { pathApi, type PlatformId } from '../platform'
import type { ProviderRegistry } from '../providers/registry'

export type EmployeeErrorCode =
  | 'invalid'
  | 'unknown-provider'
  | 'invalid-working-directory'
  | 'not-found'
  | 'running'
  | 'has-reports'

export class EmployeeError extends Error {
  constructor(
    readonly code: EmployeeErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'EmployeeError'
  }
}

interface Row {
  id: string
  name: string
  role: string
  provider_id: string
  working_directory: string
  model: string | null
  permission_mode: string
  color: string
  appearance: string
  is_manager: number
  reports_to: string | null
  instructions: string | null
  created_at: string
  updated_at: string
}

/** Fields that change how an agent is launched; they cannot change under a running agent. */
const LAUNCH_FIELDS = ['providerId', 'workingDirectory', 'model', 'permissionMode'] as const

const COLUMNS: Record<keyof EmployeeUpdate, string> = {
  name: 'name',
  role: 'role',
  providerId: 'provider_id',
  workingDirectory: 'working_directory',
  model: 'model',
  permissionMode: 'permission_mode',
  color: 'color',
  appearance: 'appearance',
  isManager: 'is_manager',
  reportsTo: 'reports_to',
  instructions: 'instructions',
}

export interface EmployeeServiceDeps {
  db: Db
  events: EventStore
  providers: ProviderRegistry
  platform: PlatformId
  isRunning: (employeeId: string) => boolean
  now?: () => Date
  newId?: () => string
}

/** Create, edit and archive employees, validating everything against the real world. */
export class EmployeeService {
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(private readonly deps: EmployeeServiceDeps) {
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? randomUUID
  }

  list(): Employee[] {
    const rows = this.deps.db
      // Ties (two hired in the same millisecond) keep hiring order: `id` is random, `rowid` is not.
      .prepare('SELECT * FROM employees WHERE archived_at IS NULL ORDER BY created_at, rowid')
      .all() as Row[]
    return rows.map(toEmployee)
  }

  get(id: string): Employee | undefined {
    const row = this.deps.db
      .prepare('SELECT * FROM employees WHERE id = ? AND archived_at IS NULL')
      .get(id) as Row | undefined
    return row && toEmployee(row)
  }

  async create(raw: EmployeeInput): Promise<Employee> {
    const parsed = EmployeeInputSchema.safeParse(raw)
    if (!parsed.success) throw new EmployeeError('invalid', firstIssue(parsed.error))
    const input = parsed.data

    this.requireProvider(input.providerId)
    const workingDirectory = await this.resolveDirectory(input.workingDirectory)
    const reportsTo = input.reportsTo ?? null
    this.checkTeam(undefined, input.isManager, reportsTo)

    const ts = this.now().toISOString()
    const id = this.newId()
    this.deps.db
      .prepare(
        `INSERT INTO employees
           (id, name, role, provider_id, working_directory, model, permission_mode, color,
            appearance, is_manager, reports_to, instructions, created_at, updated_at)
         VALUES (@id, @name, @role, @providerId, @workingDirectory, @model, @permissionMode, @color,
                 @appearance, @isManager, @reportsTo, @instructions, @ts, @ts)`,
      )
      .run({
        id,
        name: input.name,
        role: input.role,
        providerId: input.providerId,
        workingDirectory,
        model: input.model ?? null,
        permissionMode: input.permissionMode,
        color: input.color,
        appearance: JSON.stringify(input.appearance),
        isManager: input.isManager ? 1 : 0,
        reportsTo,
        instructions: input.instructions || null,
        ts,
      })

    this.deps.events.publish({
      type: 'agent.created',
      source: 'user',
      actorId: id,
      payload: { employeeId: id, providerId: input.providerId },
    })
    return this.mustGet(id)
  }

  async update(id: string, raw: EmployeeUpdate): Promise<Employee> {
    const parsed = EmployeeUpdateSchema.safeParse(raw)
    if (!parsed.success) throw new EmployeeError('invalid', firstIssue(parsed.error))
    const patch = parsed.data

    const existing = this.get(id)
    if (!existing) throw new EmployeeError('not-found', 'No such employee')

    // Becoming a manager means no longer reporting to one.
    if (patch.isManager === true && patch.reportsTo === undefined && existing.reportsTo !== null) {
      patch.reportsTo = null
    }
    const changed = (Object.keys(patch) as Array<keyof EmployeeUpdate>).filter(
      (key) => patch[key] !== undefined,
    )
    if (changed.length === 0) return existing

    if (
      this.deps.isRunning(id) &&
      changed.some((key) => (LAUNCH_FIELDS as readonly string[]).includes(key))
    ) {
      throw new EmployeeError(
        'running',
        `Stop ${existing.name} before changing its provider, folder, model or permissions`,
      )
    }
    if (patch.providerId !== undefined) this.requireProvider(patch.providerId)
    if (patch.workingDirectory !== undefined) {
      patch.workingDirectory = await this.resolveDirectory(patch.workingDirectory)
    }
    if (patch.isManager !== undefined || patch.reportsTo !== undefined) {
      this.checkTeam(
        existing,
        patch.isManager ?? existing.isManager,
        patch.reportsTo !== undefined ? patch.reportsTo : existing.reportsTo,
      )
    }

    const params: Record<string, string | number | null> = { id, ts: this.now().toISOString() }
    const sets = changed.map((key) => {
      const value = patch[key]
      params[key] =
        typeof value === 'boolean'
          ? value
            ? 1
            : 0
          : typeof value === 'string'
            ? value
            : // The look is stored as JSON; everything else that is not text is cleared.
              key === 'appearance' && value !== null && typeof value === 'object'
              ? JSON.stringify(value)
              : null
      return `${COLUMNS[key]} = @${key}`
    })
    this.deps.db
      .prepare(`UPDATE employees SET ${sets.join(', ')}, updated_at = @ts WHERE id = @id`)
      .run(params)

    this.deps.events.publish({
      type: 'employee.updated',
      source: 'user',
      actorId: id,
      payload: { employeeId: id, fields: changed },
    })
    return this.mustGet(id)
  }

  /** Soft delete: events refer to employees by id, so the row stays. */
  archive(id: string): void {
    const existing = this.get(id)
    if (!existing) throw new EmployeeError('not-found', 'No such employee')
    if (this.deps.isRunning(id)) {
      throw new EmployeeError('running', `Stop ${existing.name} before removing them`)
    }
    const reports = this.reportsOf(id)
    if (reports.length > 0) {
      throw new EmployeeError(
        'has-reports',
        `${names(reports)} report${reports.length === 1 ? 's' : ''} to ${existing.name}. Move them to another manager, or remove them first`,
      )
    }
    const ts = this.now().toISOString()
    this.deps.db
      .prepare('UPDATE employees SET archived_at = @ts, updated_at = @ts WHERE id = @id')
      .run({ id, ts })
    this.deps.events.publish({
      type: 'employee.updated',
      source: 'user',
      actorId: id,
      payload: { employeeId: id, fields: ['archived'] },
    })
  }

  /** The manager this employee reports to, if any. */
  managerOf(id: string): Employee | undefined {
    const reportsTo = this.get(id)?.reportsTo
    return reportsTo ? this.get(reportsTo) : undefined
  }

  /** The people who report to this manager. */
  reportsOf(id: string): Employee[] {
    return this.list().filter((employee) => employee.reportsTo === id)
  }

  /**
   * The team rules: a manager reports to no one; anyone else may report to a manager (never to
   * themselves, never to a non-manager, never to someone removed). A manager who still has a
   * team cannot stop being one, or their people would be left without anyone to go through.
   */
  private checkTeam(
    existing: Employee | undefined,
    isManager: boolean,
    reportsTo: string | null,
  ): void {
    if (isManager && reportsTo !== null) {
      throw new EmployeeError('invalid', 'A manager reports to the person, not to another manager')
    }
    if (reportsTo !== null) {
      if (existing && reportsTo === existing.id) {
        throw new EmployeeError('invalid', 'Nobody can report to themselves')
      }
      const manager = this.get(reportsTo)
      if (!manager) throw new EmployeeError('invalid', 'That manager does not exist')
      if (!manager.isManager) {
        throw new EmployeeError(
          'invalid',
          `${manager.name} is not a manager, so no one can report to them`,
        )
      }
    }
    if (existing && existing.isManager && !isManager) {
      const reports = this.reportsOf(existing.id)
      if (reports.length > 0) {
        throw new EmployeeError(
          'has-reports',
          `${names(reports)} report${reports.length === 1 ? 's' : ''} to ${existing.name}. Move them first`,
        )
      }
    }
  }

  private mustGet(id: string): Employee {
    const employee = this.get(id)
    if (!employee) throw new EmployeeError('not-found', 'No such employee')
    return employee
  }

  private requireProvider(providerId: string): void {
    if (!this.deps.providers.get(providerId)) {
      throw new EmployeeError('unknown-provider', `Unknown provider "${providerId}"`)
    }
  }

  /** Must be an absolute path to an existing folder. Stored in its canonical (symlink-free) form. */
  private async resolveDirectory(directory: string): Promise<string> {
    const bad = (why: string): EmployeeError =>
      new EmployeeError('invalid-working-directory', `${why}: ${directory}`)

    if (!pathApi(this.deps.platform).isAbsolute(directory))
      throw bad('The folder must be an absolute path')
    try {
      const real = await fs.realpath(directory)
      if (!(await fs.stat(real)).isDirectory()) throw bad('Not a folder')
      return real
    } catch (error) {
      if (error instanceof EmployeeError) throw error
      throw bad('The folder does not exist')
    }
  }
}

function names(employees: Employee[]): string {
  const list = employees.map((employee) => employee.name)
  return list.length <= 2
    ? list.join(' and ')
    : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`
}

function firstIssue(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  const issue = error.issues[0]
  if (!issue) return 'Invalid employee'
  const field = issue.path.map(String).join('.')
  return field ? `${field}: ${issue.message}` : issue.message
}

function toEmployee(row: Row): Employee {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    providerId: row.provider_id,
    workingDirectory: row.working_directory,
    model: row.model,
    permissionMode: row.permission_mode as PermissionMode,
    color: row.color,
    appearance: parseAppearance(row.appearance),
    isManager: row.is_manager === 1,
    reportsTo: row.reports_to,
    instructions: row.instructions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
