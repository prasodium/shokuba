import { z } from 'zod'
import { AppearanceSchema, DEFAULT_APPEARANCE, type Appearance } from './appearance'

/**
 * What an employee may be allowed to do without asking. `bypassPermissions` is
 * intentionally absent: Shokuba does not offer a way to launch an agent with permission
 * checks switched off.
 */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

const shortText = z
  .string()
  .trim()
  .min(1)
  .max(60)
  // Names end up in the UI and in file/branch names later; keep them printable.
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), 'must not contain control characters')

/** What a role is for, in a few sentences. Newlines are fine; other control characters are not. */
export const MAX_INSTRUCTIONS = 2000
const instructionsText = z
  .string()
  .trim()
  .max(MAX_INSTRUCTIONS)
  .refine(
    (value) => !/[\p{Cc}\p{Cf}]/u.test(value.replace(/[\n\r\t]/g, '')),
    'must not contain control characters',
  )

export const EmployeeInputSchema = z.strictObject({
  name: shortText,
  role: shortText,
  providerId: z.string().min(1).max(50),
  /** Absolute path of the folder this employee works in. Checked against the disk by main. */
  workingDirectory: z.string().min(1).max(1024),
  /** Optional model alias or id passed to the provider (e.g. "sonnet"). */
  model: z
    .string()
    .max(100)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/, 'model may only contain letters, digits and ._:[]-')
    .optional(),
  permissionMode: z.enum(PERMISSION_MODES).default('default'),
  /** Shirt colour of the voxel character, as #rrggbb. */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#e8893a'),
  /** How the voxel character looks, apart from the shirt: skin, hair, what they wear. */
  appearance: AppearanceSchema.default(DEFAULT_APPEARANCE),
  /** A manager leads a team and is the one who talks to the person. */
  isManager: z.boolean().default(false),
  /** The manager this employee reports to, or null. A manager reports to no one. */
  reportsTo: z.string().min(1).max(100).nullable().optional(),
  /** What this role is for; the agent is told it when it starts. */
  instructions: instructionsText.optional(),
})
export type EmployeeInput = z.input<typeof EmployeeInputSchema>

export const EmployeeUpdateSchema = EmployeeInputSchema.partial().extend({
  // `null` clears the model (back to the provider's default); `undefined` leaves it alone.
  model: EmployeeInputSchema.shape.model.unwrap().nullable().optional(),
  // A default on a partial would silently reset fields the caller did not mention.
  permissionMode: z.enum(PERMISSION_MODES).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  // The whole look is replaced at once; a part alone is never sent.
  appearance: AppearanceSchema.optional(),
  isManager: z.boolean().optional(),
  // `null` clears them; `undefined` leaves them alone.
  reportsTo: z.string().min(1).max(100).nullable().optional(),
  instructions: instructionsText.nullable().optional(),
})
export type EmployeeUpdate = z.infer<typeof EmployeeUpdateSchema>

export interface Employee {
  id: string
  name: string
  role: string
  providerId: string
  workingDirectory: string
  model: string | null
  permissionMode: PermissionMode
  color: string
  appearance: Appearance
  isManager: boolean
  /** The manager this employee reports to. Null for a manager, and for anyone not on a team. */
  reportsTo: string | null
  instructions: string | null
  createdAt: string
  updatedAt: string
}
