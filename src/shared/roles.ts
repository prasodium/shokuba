import { z } from 'zod'
import { PERMISSION_MODES, instructionsText, shortText, type PermissionMode } from './employees'

/**
 * Shokuba's own starting points for a new employee: a role, whether they lead a team, and what
 * the role is for. They are where the built-in roles come from, and what "reset to Shokuba's
 * original" puts back. Roles are edited as data (see `Role`); picking one only fills in the form,
 * and what is saved is the employee's own copy, so changing a role later never rewrites anyone.
 */
export interface RoleTemplate {
  id: string
  /** The short label shown on the desk and in the roster. */
  role: string
  isManager: boolean
  /** What this role is for, in the employee's own words. Shown to the agent when it starts. */
  instructions: string
}

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    id: 'manager',
    role: 'Manager',
    isManager: true,
    instructions:
      'You lead this team and are the one who talks to the person you work for. Your teammates bring you their questions: ' +
      'answer what you can yourself, and take to the person only what needs their decision, access or judgement. ' +
      "Keep what you send them short, and say what you need from them. Do not do your teammates' work for them.",
  },
  {
    id: 'engineer',
    role: 'Engineer',
    isManager: false,
    instructions:
      'You write and change code to complete the tasks you are given. Keep changes small and focused, ' +
      'run the tests that cover what you touched, and say plainly what you did and what you did not check.',
  },
  {
    id: 'reviewer',
    role: 'Reviewer',
    isManager: false,
    instructions:
      "You review other people's work. Read the change and the requirement, look for bugs, missing cases and unclear code, " +
      'and report concrete findings. Do not rewrite the work yourself unless asked.',
  },
  {
    id: 'qa',
    role: 'QA',
    isManager: false,
    instructions:
      'You check that things actually work. Run the code and its tests, try the awkward cases, ' +
      'and report exactly what you ran and what happened, including what failed.',
  },
]

export function roleTemplate(id: string): RoleTemplate | undefined {
  return ROLE_TEMPLATES.find((template) => template.id === id)
}

/** The id of the stored role that stands for one of Shokuba's own templates. */
export function builtinRoleId(templateId: string): string {
  return `builtin:${templateId}`
}

/**
 * A role: a starting point for hiring, which you can edit. It is not linked to anyone hired from
 * it, so editing or removing one never changes an employee.
 */
export interface Role {
  id: string
  /** The short label shown on the desk and in the roster. */
  label: string
  isManager: boolean
  /** What this role is for, in the employee's own words. Shown to the agent when it starts. */
  instructions: string
  /** The permissions a new employee in this role starts with. */
  permissionMode: PermissionMode
  /** One of Shokuba's own: it can be edited and reset to the original, but not removed. */
  builtin: boolean
  createdAt: string
  updatedAt: string
}

export const RoleInputSchema = z.strictObject({
  label: shortText,
  isManager: z.boolean().default(false),
  instructions: instructionsText.default(''),
  permissionMode: z.enum(PERMISSION_MODES).default('default'),
})
export type RoleInput = z.input<typeof RoleInputSchema>

export const RoleUpdateSchema = z.strictObject({
  label: shortText.optional(),
  isManager: z.boolean().optional(),
  instructions: instructionsText.optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
})
export type RoleUpdate = z.infer<typeof RoleUpdateSchema>
