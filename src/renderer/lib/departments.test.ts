import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE } from '@shared/appearance'
import type { Department } from '@shared/departments'
import type { Employee } from '@shared/employees'
import { groupByDepartment } from './departments'

const person = (id: string, extra: Partial<Employee> = {}): Employee => ({
  id,
  name: id,
  role: 'Engineer',
  providerId: 'mock',
  workingDirectory: '/w',
  model: null,
  permissionMode: 'default',
  color: '#e8893a',
  appearance: DEFAULT_APPEARANCE,
  departmentId: null,
  isManager: false,
  reportsTo: null,
  instructions: null,
  createdAt: 't',
  updatedAt: 't',
  ...extra,
})

const dept = (id: string): Department => ({
  id,
  name: id,
  color: '#5b8fc7',
  createdAt: 't',
  updatedAt: 't',
})

const ids = (sections: ReturnType<typeof groupByDepartment>) =>
  sections.map((s) => [s.department?.id ?? null, s.rows.map((r) => r.employee.id)])

describe('groupByDepartment', () => {
  it('is one section for everyone when there are no departments, in team order as before', () => {
    const people = [
      person('ada', { reportsTo: 'mira' }),
      person('mira', { isManager: true }),
      person('kai'),
    ]
    expect(ids(groupByDepartment(people, []))).toEqual([[null, ['mira', 'ada', 'kai']]])
  })

  it('groups people by department in the order the departments were made, then those in none', () => {
    const people = [
      person('n1'),
      person('b1', { departmentId: 'B' }),
      person('a1', { departmentId: 'A' }),
      person('a2', { departmentId: 'A' }),
    ]
    expect(ids(groupByDepartment(people, [dept('A'), dept('B')]))).toEqual([
      ['A', ['a1', 'a2']],
      ['B', ['b1']],
      [null, ['n1']],
    ])
  })

  it('keeps a manager’s team together inside a section, whoever came first', () => {
    const people = [
      person('x', { departmentId: 'A' }),
      person('ada', { departmentId: 'A', reportsTo: 'mira' }),
      person('mira', { departmentId: 'A', isManager: true }),
    ]
    expect(ids(groupByDepartment(people, [dept('A')]))).toEqual([['A', ['mira', 'ada', 'x']]])
  })

  it('leaves out a department nobody is in, and has no section for nobody in none', () => {
    const people = [person('a1', { departmentId: 'A' })]
    expect(ids(groupByDepartment(people, [dept('A'), dept('empty')]))).toEqual([['A', ['a1']]])
  })

  it('treats someone whose department is not known as in none, so nobody is lost', () => {
    const people = [person('a1', { departmentId: 'A' }), person('lost', { departmentId: 'gone' })]
    const sections = groupByDepartment(people, [dept('A')])
    expect(ids(sections)).toEqual([
      ['A', ['a1']],
      [null, ['lost']],
    ])
  })

  it('has every employee exactly once', () => {
    const people = Array.from({ length: 9 }, (_, i) =>
      person(`e${i}`, { departmentId: i % 3 === 0 ? null : i % 3 === 1 ? 'A' : 'B' }),
    )
    const all = groupByDepartment(people, [dept('A'), dept('B')]).flatMap((s) =>
      s.rows.map((r) => r.employee.id),
    )
    expect(all.sort()).toEqual(people.map((p) => p.id).sort())
  })

  it('is nothing for no one', () => {
    expect(groupByDepartment([], [dept('A')])).toEqual([])
  })
})
