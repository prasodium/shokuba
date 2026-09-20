import { describe, expect, it } from 'vitest'
import { IPC } from './channels'
import {
  DepartmentCreateRequestSchema,
  DepartmentIdRequestSchema,
  DepartmentUpdateRequestSchema,
  RoleCreateRequestSchema,
  RoleIdRequestSchema,
  RoleUpdateRequestSchema,
} from './api'

describe('the channels', () => {
  it('are each named once, all inside Shokuba’s own namespace', () => {
    const names = Object.values(IPC)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^shokuba:[a-z]+:[a-z]+(-[a-z]+)*$/)
  })

  it('give roles a channel for each thing that can be done to one', () => {
    expect(
      [
        IPC.rolesList,
        IPC.rolesCreate,
        IPC.rolesUpdate,
        IPC.rolesDuplicate,
        IPC.rolesArchive,
        IPC.rolesReset,
      ].sort(),
    ).toEqual(
      ['list', 'create', 'update', 'duplicate', 'archive', 'reset']
        .map((a) => `shokuba:roles:${a}`)
        .sort(),
    )
  })
})

describe('the role requests', () => {
  it('name a role by id, and nothing else', () => {
    expect(RoleIdRequestSchema.safeParse({ roleId: 'builtin:qa' }).success).toBe(true)
    for (const bad of [{}, { roleId: '' }, { roleId: 3 }, { roleId: 'x', extra: 1 }, 'x', null]) {
      expect(RoleIdRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('create a role from exactly what a role is, with the same defaults', () => {
    expect(RoleCreateRequestSchema.parse({ label: 'Designer' })).toEqual({
      label: 'Designer',
      isManager: false,
      instructions: '',
      permissionMode: 'default',
    })
    expect(RoleCreateRequestSchema.safeParse({ label: 'x', builtin: true }).success).toBe(false)
  })

  it('update a role by id with a patch that names only what changes', () => {
    const ok = RoleUpdateRequestSchema.safeParse({ roleId: 'r', patch: { isManager: true } })
    expect(ok.success).toBe(true)
    for (const bad of [
      { patch: { isManager: true } },
      { roleId: 'r' },
      { roleId: 'r', patch: { isManager: 'yes' } },
      { roleId: 'r', patch: { id: 'other' } },
      { roleId: 'r', patch: {}, extra: 1 },
    ]) {
      expect(RoleUpdateRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('the department requests', () => {
  it('give departments a channel for each thing that can be done to one', () => {
    expect(
      [
        IPC.departmentsList,
        IPC.departmentsCreate,
        IPC.departmentsUpdate,
        IPC.departmentsArchive,
      ].sort(),
    ).toEqual(['list', 'create', 'update', 'archive'].map((a) => `shokuba:departments:${a}`).sort())
  })

  it('name a department by id, and nothing else', () => {
    expect(DepartmentIdRequestSchema.safeParse({ departmentId: 'd' }).success).toBe(true)
    for (const bad of [{}, { departmentId: '' }, { departmentId: 'd', extra: 1 }]) {
      expect(DepartmentIdRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('create from a name and a colour, and update with a patch by id', () => {
    expect(DepartmentCreateRequestSchema.parse({ name: 'QA' }).name).toBe('QA')
    expect(
      DepartmentUpdateRequestSchema.safeParse({ departmentId: 'd', patch: { color: '#112233' } })
        .success,
    ).toBe(true)
    for (const bad of [
      { patch: { color: '#112233' } },
      { departmentId: 'd' },
      { departmentId: 'd', patch: { color: 'red' } },
      { departmentId: 'd', patch: { id: 'x' } },
    ]) {
      expect(DepartmentUpdateRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })
})
