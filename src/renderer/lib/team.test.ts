import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE } from '@shared/appearance'
import type { Employee } from '@shared/employees'
import { orderTeam } from './team'

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

const order = (employees: Employee[]): string[] =>
  orderTeam(employees).map((row) => `${row.manager ? '  ' : ''}${row.employee.id}`)

describe('orderTeam', () => {
  it('keeps hiring order when nobody has a team', () => {
    expect(order([person('a'), person('b'), person('c')])).toEqual(['a', 'b', 'c'])
  })

  it('puts each manager first, with their people under them, and everyone else last', () => {
    const employees = [
      person('loner'),
      person('ren', { reportsTo: 'mira' }),
      person('mira', { isManager: true }),
      person('sora', { reportsTo: 'mira' }),
      person('kai', { isManager: true }),
      person('yui', { reportsTo: 'kai' }),
    ]
    expect(order(employees)).toEqual(['mira', '  ren', '  sora', 'kai', '  yui', 'loner'])
  })

  it('says which manager each person sits under', () => {
    const mira = person('mira', { isManager: true })
    const rows = orderTeam([mira, person('ren', { reportsTo: 'mira' }), person('loner')])
    expect(rows.map((row) => row.manager?.id ?? null)).toEqual([null, 'mira', null])
  })

  it('does not lose or repeat anyone, even with a reporting line to someone who is not a manager', () => {
    const employees = [person('a'), person('b', { reportsTo: 'a' })]
    expect(order(employees).sort()).toEqual(['a', 'b'])
  })

  it('handles no employees', () => {
    expect(orderTeam([])).toEqual([])
  })
})
