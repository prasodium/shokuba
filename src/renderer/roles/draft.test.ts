import { describe, expect, it } from 'vitest'
import type { Role } from '@shared/roles'
import { BLANK_DRAFT, draftOf, hasChanges, sameDraft, savable } from './draft'

const role: Role = {
  id: 'r',
  label: 'Architect',
  isManager: true,
  instructions: 'Design.',
  permissionMode: 'plan',
  builtin: false,
  createdAt: 't',
  updatedAt: 't',
}

describe('draftOf', () => {
  it('holds what the role holds, and nothing that is not editable', () => {
    expect(draftOf(role)).toEqual({
      label: 'Architect',
      isManager: true,
      instructions: 'Design.',
      permissionMode: 'plan',
    })
  })
})

describe('savable', () => {
  it('trims the text and leaves the rest', () => {
    expect(savable({ ...draftOf(role), label: '  A  ', instructions: '\n x \n' })).toEqual({
      ...draftOf(role),
      label: 'A',
      instructions: 'x',
    })
  })
})

describe('sameDraft', () => {
  it('is true for what would save the same, whatever space is round the text', () => {
    expect(sameDraft(draftOf(role), { ...draftOf(role), label: ' Architect ' })).toBe(true)
    expect(sameDraft(draftOf(role), { ...draftOf(role), instructions: 'Design.\n' })).toBe(true)
  })

  it('is false when any one thing differs', () => {
    const base = draftOf(role)
    expect(sameDraft(base, { ...base, label: 'Other' })).toBe(false)
    expect(sameDraft(base, { ...base, isManager: false })).toBe(false)
    expect(sameDraft(base, { ...base, instructions: 'Design!' })).toBe(false)
    expect(sameDraft(base, { ...base, permissionMode: 'default' })).toBe(false)
  })
})

describe('hasChanges', () => {
  it('is false for a role just as it is, and true once anything differs', () => {
    expect(hasChanges(draftOf(role), role)).toBe(false)
    expect(hasChanges({ ...draftOf(role), label: 'New' }, role)).toBe(true)
    expect(hasChanges({ ...draftOf(role), permissionMode: 'acceptEdits' }, role)).toBe(true)
  })

  it('is, for a new role, whether it has a label', () => {
    expect(hasChanges(BLANK_DRAFT, undefined)).toBe(false)
    expect(hasChanges({ ...BLANK_DRAFT, label: '   ' }, undefined)).toBe(false)
    expect(hasChanges({ ...BLANK_DRAFT, label: 'Designer' }, undefined)).toBe(true)
    // Instructions alone cannot be saved: a role needs its label.
    expect(hasChanges({ ...BLANK_DRAFT, instructions: 'x' }, undefined)).toBe(false)
  })
})
