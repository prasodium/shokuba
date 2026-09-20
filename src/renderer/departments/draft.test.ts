import { describe, expect, it } from 'vitest'
import { DEPARTMENT_COLORS, type Department } from '@shared/departments'
import { BLANK_DRAFT, draftOf, hasChanges, savable } from './draft'

const saved: Department = {
  id: 'd',
  name: 'Design',
  color: '#5b8fc7',
  createdAt: 't',
  updatedAt: 't',
}

describe('a blank draft', () => {
  it('has no name and starts with the first colour', () => {
    expect(BLANK_DRAFT).toEqual({ name: '', color: DEPARTMENT_COLORS[0] })
  })
})

describe('draftOf and savable', () => {
  it('hold what the department holds, and trim the name', () => {
    expect(draftOf(saved)).toEqual({ name: 'Design', color: '#5b8fc7' })
    expect(savable({ name: '  QA ', color: '#112233' })).toEqual({ name: 'QA', color: '#112233' })
  })
})

describe('hasChanges', () => {
  it('is false for a department just as it is, whatever space is round the name or the case of the colour', () => {
    expect(hasChanges(draftOf(saved), saved)).toBe(false)
    expect(hasChanges({ name: ' Design ', color: '#5B8FC7' }, saved)).toBe(false)
  })

  it('is true once the name or the colour differs', () => {
    expect(hasChanges({ ...draftOf(saved), name: 'Other' }, saved)).toBe(true)
    expect(hasChanges({ ...draftOf(saved), color: '#e8893a' }, saved)).toBe(true)
  })

  it('is, for a new department, whether it has a name', () => {
    expect(hasChanges(BLANK_DRAFT, undefined)).toBe(false)
    expect(hasChanges({ ...BLANK_DRAFT, name: '   ' }, undefined)).toBe(false)
    expect(hasChanges({ ...BLANK_DRAFT, name: 'QA' }, undefined)).toBe(true)
    // A colour alone cannot be saved: a department needs its name.
    expect(hasChanges({ name: '', color: '#e8893a' }, undefined)).toBe(false)
  })
})
