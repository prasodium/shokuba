import { z } from 'zod'

export const MISSION_STATUSES = ['draft', 'running', 'paused', 'completed', 'cancelled'] as const
export type MissionStatus = (typeof MISSION_STATUSES)[number]

/**
 * Where a task is in its life.
 *  - pending:           waiting on dependencies
 *  - ready:             dependencies are done; can be handed to its assignee
 *  - in_progress:       handed to an agent
 *  - submitted:         the agent SAYS it is finished. That is a claim, not proof:
 *                       nothing is `done` until a person accepts it (and, from Phase 4,
 *                       until it is verified)
 *  - changes_requested: a person sent it back with a note
 *  - blocked:           the agent (or its process) could not continue
 *  - done / cancelled:  closed
 */
export const TASK_STATUSES = [
  'pending',
  'ready',
  'in_progress',
  'submitted',
  'changes_requested',
  'blocked',
  'done',
  'cancelled',
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const PRIORITIES = ['low', 'normal', 'high'] as const
export type Priority = (typeof PRIORITIES)[number]

const id = z.string().min(1).max(200)

/**
 * Text here is later pasted into an agent's terminal, so it must never carry terminal
 * control characters (an ESC could end a bracketed paste early). Titles are one printable
 * line; descriptions may also contain tabs and line breaks.
 */
export function hasControlCharacters(value: string, allowLayout: boolean): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code === 0x7f) return true
    if (code < 0x20) {
      const layout = code === 0x09 || code === 0x0a || code === 0x0d
      if (!(allowLayout && layout)) return true
    }
  }
  return false
}

const title = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (value) => !hasControlCharacters(value, false),
      'must be a single line without control characters',
    )
const description = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !hasControlCharacters(value, true), 'must not contain control characters')

export const MissionInputSchema = z.strictObject({
  title: title(120),
  description: description(4000).default(''),
  priority: z.enum(PRIORITIES).default('normal'),
})
export type MissionInput = z.input<typeof MissionInputSchema>

export const MissionUpdateSchema = z.strictObject({
  title: title(120).optional(),
  description: description(4000).optional(),
  priority: z.enum(PRIORITIES).optional(),
})
export type MissionUpdate = z.infer<typeof MissionUpdateSchema>

export const MISSION_ACTIONS = ['run', 'pause', 'cancel'] as const
export type MissionAction = (typeof MISSION_ACTIONS)[number]

export const TaskInputSchema = z.strictObject({
  missionId: id,
  title: title(160),
  description: description(8000).default(''),
  assigneeId: id.nullable().default(null),
  priority: z.enum(PRIORITIES).default('normal'),
  dependsOn: z.array(id).max(50).default([]),
})
export type TaskInput = z.input<typeof TaskInputSchema>

export const TaskUpdateSchema = z.strictObject({
  title: title(160).optional(),
  description: description(8000).optional(),
  assigneeId: id.nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
  dependsOn: z.array(id).max(50).optional(),
})
export type TaskUpdate = z.infer<typeof TaskUpdateSchema>

export const TaskActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('accept') }),
  z.strictObject({ action: z.literal('request-changes'), note: description(2000).min(1) }),
  z.strictObject({ action: z.literal('retry') }),
  z.strictObject({ action: z.literal('cancel') }),
])
export type TaskAction = z.infer<typeof TaskActionSchema>

export interface Mission {
  id: string
  title: string
  description: string
  status: MissionStatus
  priority: Priority
  /** The manager whose agent drafted this mission, or null if a person created it. */
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface Task {
  id: string
  missionId: string
  title: string
  description: string
  status: TaskStatus
  assigneeId: string | null
  priority: Priority
  /** Ids of tasks that must be `done` first. */
  dependsOn: string[]
  /** How many times this task has been handed to an agent. */
  attempts: number
  /** What the agent said it did when it submitted. Their words, not verified fact. */
  summary: string | null
  blockedReason: string | null
  /** The note from the last "request changes". */
  reviewNote: string | null
  position: number
  createdAt: string
  updatedAt: string
  startedAt: string | null
  submittedAt: string | null
  completedAt: string | null
}

export interface MissionDetail {
  mission: Mission
  tasks: Task[]
}
