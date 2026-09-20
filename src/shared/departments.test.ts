import { describe, expect, it } from 'vitest'
import { EmployeeInputSchema, EmployeeUpdateSchema } from './employees'
import { DEPARTMENT_COLORS, DepartmentInputSchema, DepartmentUpdateSchema } from './departments'

describe('the colours offered', () => {
  it('are valid, different from each other, and enough to tell departments apart', () => {
    for (const color of DEPARTMENT_COLORS) expect(color).toMatch(/^#[0-9a-f]{6}$/)
    expect(new Set(DEPARTMENT_COLORS).size).toBe(DEPARTMENT_COLORS.length)
    expect(DEPARTMENT_COLORS.length).toBeGreaterThanOrEqual(6)
  })
})

describe('DepartmentInputSchema', () => {
  it('needs only a name, and starts with the first colour', () => {
    expect(DepartmentInputSchema.parse({ name: 'Design' })).toEqual({
      name: 'Design',
      color: DEPARTMENT_COLORS[0],
    })
  })

  it('trims the name and keeps a colour that is a colour', () => {
    expect(DepartmentInputSchema.parse({ name: '  QA ', color: '#AABBCC' })).toEqual({
      name: 'QA',
      color: '#AABBCC',
    })
  })

  it('refuses an empty, over-long or control-character name, a bad colour and unknown fields', () => {
    for (const bad of [
      { name: '' },
      { name: 'x'.repeat(61) },
      { name: `a${String.fromCharCode(7)}` },
      { name: 'ok', color: 'blue' },
      { name: 'ok', color: '#abc' },
      { name: 'ok', color: 'rgb(0,0,0)' },
      { name: 'ok', extra: 1 },
      {},
    ]) {
      expect(DepartmentInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('DepartmentUpdateSchema', () => {
  it('has no defaults, so a patch changes only what it names', () => {
    expect(DepartmentUpdateSchema.parse({})).toEqual({})
    expect(DepartmentUpdateSchema.parse({ color: '#112233' })).toEqual({ color: '#112233' })
  })

  it('refuses what a new one would refuse', () => {
    for (const bad of [{ name: '' }, { color: 'x' }, { id: 'other' }]) {
      expect(DepartmentUpdateSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('an employee’s department', () => {
  const base = { name: 'Ada', role: 'Engineer', providerId: 'mock', workingDirectory: '/w' }

  it('is optional when hiring, and can be named or none', () => {
    expect(EmployeeInputSchema.safeParse(base).success).toBe(true)
    expect(EmployeeInputSchema.safeParse({ ...base, departmentId: 'd1' }).success).toBe(true)
    expect(EmployeeInputSchema.safeParse({ ...base, departmentId: null }).success).toBe(true)
    expect(EmployeeInputSchema.safeParse({ ...base, departmentId: '' }).success).toBe(false)
  })

  it('is left alone by a patch that does not mention it, and cleared by null', () => {
    expect(EmployeeUpdateSchema.parse({ name: 'x' })).not.toHaveProperty('departmentId')
    expect(EmployeeUpdateSchema.parse({ departmentId: null })).toEqual({ departmentId: null })
    expect(EmployeeUpdateSchema.parse({ departmentId: 'd1' })).toEqual({ departmentId: 'd1' })
  })
})
