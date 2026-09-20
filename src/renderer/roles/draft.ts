import type { PermissionMode } from '@shared/employees'
import type { Role } from '@shared/roles'

/** What the roles form holds for a role being written or edited. */
export interface Draft {
  label: string
  isManager: boolean
  instructions: string
  permissionMode: PermissionMode
}

export const BLANK_DRAFT: Draft = {
  label: '',
  isManager: false,
  instructions: '',
  permissionMode: 'default',
}

export const draftOf = (role: Role): Draft => ({
  label: role.label,
  isManager: role.isManager,
  instructions: role.instructions,
  permissionMode: role.permissionMode,
})

/** The draft as it would be saved: text trimmed, as the main process trims it. */
export const savable = (draft: Draft): Draft => ({
  ...draft,
  label: draft.label.trim(),
  instructions: draft.instructions.trim(),
})

/** Whether two drafts would save as the same role. Space round the text does not count. */
export function sameDraft(a: Draft, b: Draft): boolean {
  const x = savable(a)
  const y = savable(b)
  return (
    x.label === y.label &&
    x.isManager === y.isManager &&
    x.instructions === y.instructions &&
    x.permissionMode === y.permissionMode
  )
}

/**
 * Whether there is something to save. For an existing role, any difference from it; for a new one,
 * a label (nothing else can be saved without one).
 */
export function hasChanges(draft: Draft, saved: Role | undefined): boolean {
  return saved ? !sameDraft(draft, draftOf(saved)) : draft.label.trim() !== ''
}
