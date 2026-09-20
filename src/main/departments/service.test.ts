import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServices, type Services } from '../bootstrap'
import { EmployeeService } from '../employees/service'
import { createLogger } from '../logging/logger'
import { toPlatformId } from '../platform'
import { createMockAdapter } from '../providers/mock/adapter'
import { ProviderRegistry } from '../providers/registry'
import { DepartmentError, type DepartmentService } from './service'

let dir: string
let workdir: string
let services: Services
let departments: DepartmentService
let employees: EmployeeService

const open = () =>
  createServices({
    dataDir: join(dir, 'data'),
    version: 'test',
    platform: toPlatformId(),
    logger: createLogger(() => {}),
  })

const employeesOn = (s: Services) =>
  new EmployeeService({
    db: s.db,
    events: s.events,
    providers: new ProviderRegistry([createMockAdapter()]),
    platform: toPlatformId(),
    isRunning: () => false,
  })

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'shokuba-departments-')))
  workdir = join(dir, 'work')
  mkdirSync(workdir)
  services = open()
  departments = services.departments
  employees = employeesOn(services)
})

afterEach(() => {
  services.close()
  rmSync(dir, { recursive: true, force: true })
})

const hire = (name: string, extra: Record<string, unknown> = {}) =>
  employees.create({
    name,
    role: 'Engineer',
    providerId: 'mock',
    workingDirectory: workdir,
    ...extra,
  })

const rejection = (fn: () => unknown): DepartmentError => {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(DepartmentError)
    return error as DepartmentError
  }
  throw new Error('expected a DepartmentError')
}

const events = (type: 'department.created' | 'department.updated' | 'employee.updated') =>
  services.events.log.list({ type })

describe('DepartmentService.create', () => {
  it('starts with none, and makes one with a colour, listed in the order made', () => {
    expect(departments.list()).toEqual([])
    const a = departments.create({ name: 'Engineering', color: '#5b8fc7' })
    const b = departments.create({ name: 'QA' })
    expect(a).toMatchObject({ name: 'Engineering', color: '#5b8fc7' })
    expect(b.color).toMatch(/^#[0-9a-f]{6}$/i)
    expect(departments.list().map((d) => d.name)).toEqual(['Engineering', 'QA'])
    expect(departments.get(a.id)).toEqual(a)
  })

  it('records that it was made, by id only', () => {
    const d = departments.create({ name: 'Engineering' })
    const [event] = events('department.created')
    expect(event).toMatchObject({ source: 'user', payload: { departmentId: d.id } })
    expect(JSON.stringify(event)).not.toContain('Engineering')
  })

  it('refuses bad input, and makes nothing', () => {
    for (const bad of [
      { name: '' },
      { name: '  ' },
      { name: 'x'.repeat(61) },
      { name: `a${String.fromCharCode(0)}b` },
      { name: 'ok', color: 'red' },
      { name: 'ok', color: '#12345' },
      { name: 'ok', extra: 1 } as never,
    ]) {
      expect(rejection(() => departments.create(bad)).code, JSON.stringify(bad)).toBe('invalid')
    }
    expect(departments.list()).toEqual([])
  })

  it('refuses a name that is taken, whatever the case, but not one that was removed', () => {
    const d = departments.create({ name: 'Design' })
    expect(rejection(() => departments.create({ name: 'DESIGN' })).message).toContain('already')
    departments.archive(d.id)
    expect(departments.create({ name: 'Design' }).name).toBe('Design')
  })
})

describe('DepartmentService.update', () => {
  it('changes what is given and says which, and does nothing for no change', () => {
    const d = departments.create({ name: 'Design', color: '#5b8fc7' })
    const updated = departments.update(d.id, { color: '#e8893a' })
    expect(updated).toMatchObject({ name: 'Design', color: '#e8893a' })
    expect(events('department.updated').at(-1)).toMatchObject({
      payload: { departmentId: d.id, fields: ['color'] },
    })
    const before = events('department.updated').length
    expect(departments.update(d.id, { name: 'Design', color: '#e8893a' })).toEqual(updated)
    expect(departments.update(d.id, {})).toEqual(updated)
    expect(events('department.updated')).toHaveLength(before)
  })

  it('refuses a name another department has, but lets one keep its own', () => {
    departments.create({ name: 'QA' })
    const d = departments.create({ name: 'Design' })
    expect(rejection(() => departments.update(d.id, { name: 'qa' })).code).toBe('invalid')
    expect(departments.update(d.id, { name: 'DESIGN' }).name).toBe('DESIGN')
  })

  it('refuses what is not valid, and reports one that is not there', () => {
    const d = departments.create({ name: 'Design' })
    expect(rejection(() => departments.update(d.id, { color: 'nope' })).code).toBe('invalid')
    expect(rejection(() => departments.update('nope', { name: 'x' })).code).toBe('not-found')
    departments.archive(d.id)
    expect(rejection(() => departments.update(d.id, { name: 'x' })).code).toBe('not-found')
  })
})

describe('putting people in a department', () => {
  it('hires someone into one, and lists them there', async () => {
    const d = departments.create({ name: 'Engineering' })
    const ada = await hire('Ada', { departmentId: d.id })
    expect(ada.departmentId).toBe(d.id)
    expect(employees.get(ada.id)?.departmentId).toBe(d.id)
    expect((await hire('Bo')).departmentId).toBeNull()
  })

  it('moves someone into one, out of one, and to another, and says so', async () => {
    const a = departments.create({ name: 'A' })
    const b = departments.create({ name: 'B' })
    const ada = await hire('Ada')
    expect((await employees.update(ada.id, { departmentId: a.id })).departmentId).toBe(a.id)
    expect((await employees.update(ada.id, { departmentId: b.id })).departmentId).toBe(b.id)
    expect((await employees.update(ada.id, { departmentId: null })).departmentId).toBeNull()
    const updates = events('employee.updated').map((e) => e.payload)
    expect(updates.every((p) => (p as { fields: string[] }).fields.join() === 'departmentId')).toBe(
      true,
    )
    expect(updates).toHaveLength(3)
  })

  it('leaves the department alone when something else is edited', async () => {
    const d = departments.create({ name: 'A' })
    const ada = await hire('Ada', { departmentId: d.id })
    expect((await employees.update(ada.id, { name: 'Ava' })).departmentId).toBe(d.id)
  })

  it('refuses a department that does not exist or was removed, for hiring and for moving', async () => {
    const d = departments.create({ name: 'Gone' })
    departments.archive(d.id)
    for (const id of ['nope', d.id]) {
      await expect(hire('Ada', { departmentId: id })).rejects.toMatchObject({ code: 'invalid' })
    }
    const ada = await hire('Ada')
    await expect(employees.update(ada.id, { departmentId: 'nope' })).rejects.toMatchObject({
      code: 'invalid',
    })
    expect(employees.get(ada.id)?.departmentId).toBeNull()
  })

  it('does not touch who reports to whom: a team may span departments', async () => {
    const a = departments.create({ name: 'A' })
    const b = departments.create({ name: 'B' })
    const boss = await hire('Boss', { isManager: true, departmentId: a.id })
    const ada = await hire('Ada', { reportsTo: boss.id, departmentId: b.id })
    expect(ada).toMatchObject({ reportsTo: boss.id, departmentId: b.id })
  })
})

describe('DepartmentService.archive', () => {
  it('removes it, takes its people out of it, and removes nobody', async () => {
    const d = departments.create({ name: 'Design' })
    const keep = departments.create({ name: 'Keep' })
    const ada = await hire('Ada', { departmentId: d.id })
    const bo = await hire('Bo', { departmentId: d.id })
    const cy = await hire('Cy', { departmentId: keep.id })
    departments.archive(d.id)
    expect(departments.get(d.id)).toBeUndefined()
    expect(departments.list().map((x) => x.id)).toEqual([keep.id])
    expect(employees.get(ada.id)).toMatchObject({ name: 'Ada', departmentId: null })
    expect(employees.get(bo.id)).toMatchObject({ name: 'Bo', departmentId: null })
    expect(employees.get(cy.id)?.departmentId).toBe(keep.id)
    expect(employees.list()).toHaveLength(3)
  })

  it('records each person moved, and that the department was removed', async () => {
    const d = departments.create({ name: 'Design' })
    const ada = await hire('Ada', { departmentId: d.id })
    departments.archive(d.id)
    const moved = events('employee.updated').filter((e) => e.actorId === ada.id)
    expect(moved.at(-1)).toMatchObject({
      payload: { employeeId: ada.id, fields: ['departmentId'] },
    })
    expect(events('department.updated').at(-1)).toMatchObject({
      payload: { departmentId: d.id, fields: ['archived'] },
    })
  })

  it('reports one that is not there', () => {
    expect(rejection(() => departments.archive('nope')).code).toBe('not-found')
  })
})

describe('headcounts', () => {
  it('counts the people in each department, not those removed', async () => {
    const a = departments.create({ name: 'A' })
    const b = departments.create({ name: 'B' })
    await hire('Ada', { departmentId: a.id })
    const bo = await hire('Bo', { departmentId: a.id })
    await hire('Cy', { departmentId: b.id })
    await hire('Di')
    employees.archive(bo.id)
    expect(departments.headcounts()).toEqual({ [a.id]: 1, [b.id]: 1 })
  })
})

describe('persistence', () => {
  it('keeps departments, their people and removals across a restart', async () => {
    const keep = departments.create({ name: 'Keep', color: '#e8893a' })
    const drop = departments.create({ name: 'Drop' })
    const ada = await hire('Ada', { departmentId: keep.id })
    departments.archive(drop.id)
    services.close()
    services = open()
    departments = services.departments
    employees = employeesOn(services)
    expect(departments.list()).toEqual([keep])
    expect(employees.get(ada.id)?.departmentId).toBe(keep.id)
  })
})
