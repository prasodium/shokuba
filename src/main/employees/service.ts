import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
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
  'invalid' | 'unknown-provider' | 'invalid-working-directory' | 'not-found' | 'running'

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
      .prepare('SELECT * FROM employees WHERE archived_at IS NULL ORDER BY created_at, id')
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

    const ts = this.now().toISOString()
    const id = this.newId()
    this.deps.db
      .prepare(
        `INSERT INTO employees
           (id, name, role, provider_id, working_directory, model, permission_mode, color, created_at, updated_at)
         VALUES (@id, @name, @role, @providerId, @workingDirectory, @model, @permissionMode, @color, @ts, @ts)`,
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

    const params: Record<string, string | null> = { id, ts: this.now().toISOString() }
    const sets = changed.map((key) => {
      const value = patch[key]
      params[key] = typeof value === 'string' ? value : null
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
