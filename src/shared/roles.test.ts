import { describe, expect, it } from 'vitest'
import { EmployeeInputSchema } from './employees'
import { ROLE_TEMPLATES, roleTemplate } from './roles'

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
