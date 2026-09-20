import { describe, expect, it } from 'vitest'
import { planningView } from './planning'

const people = [
  { id: 'e1', name: 'Mira', isManager: true },
  { id: 'e2', name: 'Ren', isManager: false },
  { id: 'e3', name: 'Kai', isManager: true },
]

describe('planningView', () => {
  it('offers the managers, and only the managers, for a draft nobody has', () => {
    expect(planningView({ status: 'draft', plannerId: null }, people)).toEqual({
      kind: 'ask',
      managers: [
        { id: 'e1', name: 'Mira' },
        { id: 'e3', name: 'Kai' },
      ],
    })
  })

  it('says there is no one to ask when nobody is a manager', () => {
    expect(planningView({ status: 'draft', plannerId: null }, [people[1]!])).toEqual({
      kind: 'no-manager',
    })
    expect(planningView({ status: 'draft', plannerId: null }, [])).toEqual({ kind: 'no-manager' })
  })

  it('says who has it once it is handed over', () => {
    expect(planningView({ status: 'draft', plannerId: 'e3' }, people)).toEqual({
      kind: 'planning',
      managerName: 'Kai',
    })
  })

  it('still says it is with someone when that person is no longer listed', () => {
    expect(planningView({ status: 'draft', plannerId: 'gone' }, people)).toEqual({
      kind: 'planning',
      managerName: 'a manager',
    })
  })

  it('offers nothing once the mission has been run, paused, finished or cancelled', () => {
    for (const status of ['running', 'paused', 'completed', 'cancelled'] as const) {
      expect(planningView({ status, plannerId: null }, people), status).toEqual({ kind: 'hidden' })
      expect(planningView({ status, plannerId: 'e1' }, people), status).toEqual({ kind: 'hidden' })
    }
  })
})
