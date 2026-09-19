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

describe('teams', () => {
  const manager = (name = 'Mira') =>
    service.create({ ...valid(), name, role: 'Manager', isManager: true })
  const reportTo = (boss: { id: string }, name: string) =>
    service.create({ ...valid(), name, reportsTo: boss.id })

  it('starts everyone as a peer with no instructions', async () => {
    expect(await service.create(valid())).toMatchObject({
      isManager: false,
      reportsTo: null,
      instructions: null,
    })
  })

  it('creates a manager, and people who report to them', async () => {
    const mira = await manager()
    const ren = await reportTo(mira, 'Ren')
    expect(mira).toMatchObject({ isManager: true, reportsTo: null })
    expect(ren).toMatchObject({ isManager: false, reportsTo: mira.id })
    expect(service.managerOf(ren.id)?.id).toBe(mira.id)
    expect(service.managerOf(mira.id)).toBeUndefined()
    expect(service.reportsOf(mira.id).map((e) => e.name)).toEqual(['Ren'])
  })

  it('keeps the instructions, and trims them', async () => {
    const employee = await service.create({
      ...valid(),
      instructions: '  Write the API.\nKeep it small.  ',
    })
    expect(employee.instructions).toBe('Write the API.\nKeep it small.')
  })

  it('refuses instructions with control characters, but allows line breaks', async () => {
    const bad = await rejection(
      service.create({ ...valid(), instructions: 'do this' + String.fromCharCode(27) + '[2J' }),
    )
    expect(bad.code).toBe('invalid')
    await expect(service.create({ ...valid(), instructions: 'one\ntwo' })).resolves.toBeDefined()
  })

  it('refuses to report to someone who is not a manager, does not exist, or is oneself', async () => {
    const peer = await service.create(valid())
    expect((await rejection(reportTo(peer, 'Ren'))).message).toMatch(/is not a manager/)
    expect((await rejection(reportTo({ id: 'nobody' }, 'Ren'))).message).toMatch(/does not exist/)
    const mira = await manager()
    expect((await rejection(service.update(mira.id, { reportsTo: mira.id }))).message).toMatch(
      /themselves|reports to the person/,
    )
  })

  it('refuses a manager who reports to another manager', async () => {
    const mira = await manager()
    const error = await rejection(
      service.create({ ...valid(), name: 'Kai', isManager: true, reportsTo: mira.id }),
    )
    expect(error.message).toMatch(/reports to the person/)
  })

  it('moves someone to another manager, or off the team, and records the change', async () => {
    const mira = await manager()
    const kai = await manager('Kai')
    const ren = await reportTo(mira, 'Ren')
    expect((await service.update(ren.id, { reportsTo: kai.id })).reportsTo).toBe(kai.id)
    expect((await service.update(ren.id, { reportsTo: null })).reportsTo).toBeNull()
    const events = services.events.log.list({ type: 'employee.updated' })
    expect(events.at(-1)?.payload).toMatchObject({ employeeId: ren.id, fields: ['reportsTo'] })
  })

  it("promoting someone to manager takes them off their old manager's team", async () => {
    const mira = await manager()
    const ren = await reportTo(mira, 'Ren')
    const promoted = await service.update(ren.id, { isManager: true })
    expect(promoted).toMatchObject({ isManager: true, reportsTo: null })
    expect(service.reportsOf(mira.id)).toEqual([])
  })

  it('does not let a manager stop being one while people report to them', async () => {
    const mira = await manager()
    await reportTo(mira, 'Ren')
    await reportTo(mira, 'Sora')
    const error = await rejection(service.update(mira.id, { isManager: false }))
    expect(error.code).toBe('has-reports')
    expect(error.message).toBe('Ren and Sora report to Mira. Move them first')
  })

  it('does not let a manager be removed while people report to them, and allows it once they are moved', async () => {
    const mira = await manager()
    const ren = await reportTo(mira, 'Ren')
    expect(() => service.archive(mira.id)).toThrow(/Ren reports to Mira/)
    await service.update(ren.id, { reportsTo: null })
    service.archive(mira.id)
    expect(service.get(mira.id)).toBeUndefined()
  })

  it('leaves the team alone when an unrelated field is edited', async () => {
    const mira = await manager()
    const ren = await reportTo(mira, 'Ren')
    const renamed = await service.update(ren.id, { role: 'Senior engineer' })
    expect(renamed).toMatchObject({ reportsTo: mira.id, isManager: false })
  })

  it('clears instructions with null, and leaves them alone when not mentioned', async () => {
    const employee = await service.create({ ...valid(), instructions: 'Be careful.' })
    expect((await service.update(employee.id, { role: 'QA' })).instructions).toBe('Be careful.')
    expect((await service.update(employee.id, { instructions: null })).instructions).toBeNull()
  })

  it('lets team details change while the agent is running, since they are not launch settings', async () => {
    const mira = await manager()
    const ren = await service.create(valid())
    running.add(ren.id)
    await expect(service.update(ren.id, { reportsTo: mira.id })).resolves.toMatchObject({
      reportsTo: mira.id,
    })
  })
})

describe('listing', () => {
  it('keeps hiring order for people hired in the same instant', async () => {
    const frozen = new EmployeeService({
      db: services.db,
      events: services.events,
      providers: new ProviderRegistry([createMockAdapter()]),
      platform: toPlatformId(),
      isRunning: () => false,
      now: () => new Date(Date.UTC(2026, 0, 1)),
    })
    // Ids that sort against hiring order, so ordering by id would get this wrong.
    const ids = ['zzz', 'mmm', 'aaa']
    for (const [i, id] of ids.entries()) {
      await new EmployeeService({
        db: services.db,
        events: services.events,
        providers: new ProviderRegistry([createMockAdapter()]),
        platform: toPlatformId(),
        isRunning: () => false,
        now: () => new Date(Date.UTC(2026, 0, 1)),
        newId: () => id,
      }).create({ ...valid(), name: `P${i}` })
    }
    expect(frozen.list().map((e) => e.id)).toEqual(ids)
  })
})
