import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServices, type Services } from '../bootstrap'
import { createLogger } from '../logging/logger'
import { toPlatformId } from '../platform'
import { createMockAdapter } from '../providers/mock/adapter'
import { ProviderRegistry } from '../providers/registry'
import { EmployeeError, EmployeeService } from './service'

let dir: string
let workdir: string
let services: Services
let running: Set<string>
let service: EmployeeService

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'shokuba-employees-')))
  workdir = join(dir, 'work')
  mkdirSync(workdir)
  services = createServices({
    dataDir: join(dir, 'data'),
    version: 'test',
    platform: toPlatformId(),
    logger: createLogger(() => {}),
  })
  running = new Set()
  service = new EmployeeService({
    db: services.db,
    events: services.events,
    providers: new ProviderRegistry([createMockAdapter()]),
    platform: toPlatformId(),
    isRunning: (id) => running.has(id),
  })
})

afterEach(() => {
  services.close()
  rmSync(dir, { recursive: true, force: true })
})

const valid = () => ({
  name: 'Mika',
  role: 'Engineer',
  providerId: 'mock',
  workingDirectory: workdir,
})

async function rejection(promise: Promise<unknown>): Promise<EmployeeError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(EmployeeError)
  return error as EmployeeError
}

describe('EmployeeService.create', () => {
  it('creates an employee with defaults and lists it', async () => {
    const employee = await service.create(valid())
    expect(employee).toMatchObject({
      name: 'Mika',
      role: 'Engineer',
      providerId: 'mock',
      workingDirectory: workdir,
      model: null,
      permissionMode: 'default',
      color: '#e8893a',
    })
    expect(service.list()).toEqual([employee])
    expect(service.get(employee.id)).toEqual(employee)
  })

  it('records an agent.created event attributed to the user', async () => {
    const employee = await service.create(valid())
    const [event] = services.events.log.list({ type: 'agent.created' })
    expect(event).toMatchObject({
      source: 'user',
      actorId: employee.id,
      payload: { employeeId: employee.id, providerId: 'mock' },
    })
  })

  // Creating symlinks on Windows needs elevated rights that a developer machine may lack.
  it.skipIf(toPlatformId() === 'win32')(
    'stores the canonical folder, resolving symlinks',
    async () => {
      const link = join(dir, 'link')
      symlinkSync(workdir, link)
      const employee = await service.create({ ...valid(), workingDirectory: link })
      expect(employee.workingDirectory).toBe(workdir)
    },
  )

  it('trims names', async () => {
    expect((await service.create({ ...valid(), name: '  Mika  ' })).name).toBe('Mika')
  })

  it('rejects bad input', async () => {
    expect((await rejection(service.create({ ...valid(), name: '' }))).code).toBe('invalid')
    expect((await rejection(service.create({ ...valid(), name: 'a\u0000b' }))).code).toBe('invalid')
    expect((await rejection(service.create({ ...valid(), color: 'red' }))).code).toBe('invalid')
    expect((await rejection(service.create({ ...valid(), model: '--dangerous' }))).code).toBe(
      'invalid',
    )
    expect(
      (
        await rejection(
          service.create({ ...valid(), permissionMode: 'bypassPermissions' as never }),
        )
      ).code,
    ).toBe('invalid')
  })

  it('rejects an unknown provider', async () => {
    expect((await rejection(service.create({ ...valid(), providerId: 'nope' }))).code).toBe(
      'unknown-provider',
    )
  })

  it('rejects folders that are relative, missing, or not folders', async () => {
    expect(
      (await rejection(service.create({ ...valid(), workingDirectory: 'relative/path' }))).code,
    ).toBe('invalid-working-directory')
    expect(
      (await rejection(service.create({ ...valid(), workingDirectory: join(dir, 'nope') }))).code,
    ).toBe('invalid-working-directory')
    const file = join(dir, 'file.txt')
    writeFileSync(file, 'x')
    expect((await rejection(service.create({ ...valid(), workingDirectory: file }))).code).toBe(
      'invalid-working-directory',
    )
  })

  it('persists across a restart', async () => {
    const employee = await service.create(valid())
    services.close()
    services = createServices({
      dataDir: join(dir, 'data'),
      version: 'test',
      platform: toPlatformId(),
      logger: createLogger(() => {}),
    })
    const reopened = new EmployeeService({
      db: services.db,
      events: services.events,
      providers: new ProviderRegistry([createMockAdapter()]),
      platform: toPlatformId(),
      isRunning: () => false,
    })
    expect(reopened.list()).toEqual([employee])
  })
})

describe('EmployeeService.update', () => {
  it('changes only the fields given, and records which', async () => {
    const employee = await service.create(valid())
    const updated = await service.update(employee.id, { role: 'Reviewer', color: '#112233' })
    expect(updated).toMatchObject({
      name: 'Mika',
      role: 'Reviewer',
      color: '#112233',
      permissionMode: 'default',
    })
    const [event] = services.events.log.list({ type: 'employee.updated' })
    expect(event?.payload).toEqual({ employeeId: employee.id, fields: ['role', 'color'] })
  })

  it('can set the model and later clear it back to the provider default', async () => {
    const employee = await service.create({ ...valid(), model: 'haiku' })
    expect(employee.model).toBe('haiku')
    expect((await service.update(employee.id, { model: 'opus' })).model).toBe('opus')
    expect((await service.update(employee.id, { model: null })).model).toBeNull()
  })

  it('does nothing, and says nothing, for an empty patch', async () => {
    const employee = await service.create(valid())
    expect(await service.update(employee.id, {})).toEqual(employee)
    expect(services.events.log.list({ type: 'employee.updated' })).toHaveLength(0)
  })

  it('validates a new folder like a new employee', async () => {
    const employee = await service.create(valid())
    expect(
      (await rejection(service.update(employee.id, { workingDirectory: join(dir, 'gone') }))).code,
    ).toBe('invalid-working-directory')
  })

  it('allows renaming a running agent but not changing how it was launched', async () => {
    const employee = await service.create(valid())
    running.add(employee.id)
    expect((await service.update(employee.id, { name: 'Mika 2' })).name).toBe('Mika 2')
    expect((await rejection(service.update(employee.id, { model: 'sonnet' }))).code).toBe('running')
    expect((await rejection(service.update(employee.id, { workingDirectory: workdir }))).code).toBe(
      'running',
    )
  })

  it('reports an unknown employee', async () => {
    expect((await rejection(service.update('missing', { name: 'x' }))).code).toBe('not-found')
  })
})

describe('EmployeeService.archive', () => {
  it('hides the employee but keeps their history', async () => {
    const employee = await service.create(valid())
    service.archive(employee.id)
    expect(service.list()).toEqual([])
    expect(service.get(employee.id)).toBeUndefined()
    expect(services.events.log.list({ type: 'agent.created' })).toHaveLength(1)
  })

  it('refuses while the agent is running', async () => {
    const employee = await service.create(valid())
    running.add(employee.id)
    expect(() => service.archive(employee.id)).toThrow(/Stop Mika/)
    expect(service.list()).toHaveLength(1)
  })

  it('reports an unknown employee', () => {
    expect(() => service.archive('missing')).toThrow(EmployeeError)
  })
})
