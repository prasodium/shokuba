import { z } from 'zod'

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
  createdAt: string
  updatedAt: string
}
