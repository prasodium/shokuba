import { describe, expect, it } from 'vitest'
import { EmployeeInputSchema, PERMISSION_MODES } from './employees'
import {
  ROLE_TEMPLATES,
  RoleInputSchema,
  RoleUpdateSchema,
  builtinRoleId,
  roleTemplate,
} from './roles'

describe('role templates', () => {
  it('each make a valid employee, so picking one can never produce a form that is refused', () => {
    for (const template of ROLE_TEMPLATES) {
      const parsed = EmployeeInputSchema.safeParse({
        name: 'Test',
        role: template.role,
        providerId: 'mock',
        workingDirectory: '/tmp',
        isManager: template.isManager,
        instructions: template.instructions,
      })
      expect(parsed.success, template.id).toBe(true)
    }
  })

  it('have distinct ids and roles', () => {
    expect(new Set(ROLE_TEMPLATES.map((t) => t.id)).size).toBe(ROLE_TEMPLATES.length)
    expect(new Set(ROLE_TEMPLATES.map((t) => t.role)).size).toBe(ROLE_TEMPLATES.length)
  })

  it('offer exactly one way to start a manager, and it says the manager talks to the person', () => {
    const managers = ROLE_TEMPLATES.filter((t) => t.isManager)
    expect(managers.map((t) => t.id)).toEqual(['manager'])
    expect(managers[0]?.instructions).toContain('talks to the person')
  })

  it('never tell a non-manager to message the person directly', () => {
    for (const template of ROLE_TEMPLATES.filter((t) => !t.isManager)) {
      expect(template.instructions).not.toMatch(/human|message the person/i)
    }
  })

  it('can be looked up by id', () => {
    expect(roleTemplate('qa')?.role).toBe('QA')
    expect(roleTemplate('nope')).toBeUndefined()
  })
})

describe('RoleInputSchema', () => {
  it('needs only a label, and fills in the rest with what a new role starts with', () => {
    expect(RoleInputSchema.parse({ label: 'Designer' })).toEqual({
      label: 'Designer',
      isManager: false,
      instructions: '',
      permissionMode: 'default',
    })
  })

  it('accepts every permission mode Shokuba offers, and no other', () => {
    for (const mode of PERMISSION_MODES) {
      expect(RoleInputSchema.safeParse({ label: 'x', permissionMode: mode }).success).toBe(true)
    }
    for (const bad of ['bypassPermissions', 'root', '', 3]) {
      expect(
        RoleInputSchema.safeParse({ label: 'x', permissionMode: bad }).success,
        String(bad),
      ).toBe(false)
    }
  })

  it('refuses an empty, over-long or control-character label and unknown fields', () => {
    for (const bad of [
      { label: '' },
      { label: 'x'.repeat(61) },
      { label: `a${String.fromCharCode(7)}b` },
      { label: 'x', extra: true },
      {},
    ]) {
      expect(RoleInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('makes an employee the form would accept, so a role can never produce a form that is refused', () => {
    const role = RoleInputSchema.parse({
      label: 'Architect',
      isManager: true,
      instructions: 'Design.\nKeep it simple.',
      permissionMode: 'plan',
    })
    const parsed = EmployeeInputSchema.safeParse({
      name: 'Test',
      role: role.label,
      providerId: 'mock',
      workingDirectory: '/tmp',
      isManager: role.isManager,
      instructions: role.instructions,
      permissionMode: role.permissionMode,
    })
    expect(parsed.success).toBe(true)
  })
})

describe('RoleUpdateSchema', () => {
  it('has no defaults, so a patch changes only what it names', () => {
    expect(RoleUpdateSchema.parse({})).toEqual({})
    expect(RoleUpdateSchema.parse({ isManager: true })).toEqual({ isManager: true })
  })

  it('refuses what a new role would refuse', () => {
    for (const bad of [
      { label: '' },
      { instructions: 'x'.repeat(2001) },
      { permissionMode: 'x' },
      { id: 'x' },
    ]) {
      expect(RoleUpdateSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('builtinRoleId', () => {
  it('names the stored role for each template, differently for each', () => {
    const ids = ROLE_TEMPLATES.map((t) => builtinRoleId(t.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(builtinRoleId('qa')).toBe('builtin:qa')
  })
})
