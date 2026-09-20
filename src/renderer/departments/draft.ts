import { DEPARTMENT_COLORS, type Department } from '@shared/departments'

/** What the departments form holds for a department being written or edited. */
export interface Draft {
  name: string
  color: string
}

export const BLANK_DRAFT: Draft = { name: '', color: DEPARTMENT_COLORS[0] }

export const draftOf = (department: Department): Draft => ({
  name: department.name,
  color: department.color,
})

/** The draft as it would be saved: the name trimmed, as the main process trims it. */
export const savable = (draft: Draft): Draft => ({ ...draft, name: draft.name.trim() })

/**
 * Whether there is something to save: for an existing department, any difference from it; for a
 * new one, a name (it cannot be saved without one).
 */
export function hasChanges(draft: Draft, saved: Department | undefined): boolean {
  if (!saved) return draft.name.trim() !== ''
  const now = savable(draft)
  return now.name !== saved.name || now.color.toLowerCase() !== saved.color.toLowerCase()
}
