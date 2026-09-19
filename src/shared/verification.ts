import { z } from 'zod'

/**
 * Checks: commands the person defines for a project and Shokuba runs on the work an agent
 * submits. `setup` steps (installing dependencies, say) run first; `check` steps are what is
 * judged. They are the person's words, stored in Shokuba, and never read from anything an agent
 * wrote.
 */
export const CHECK_KINDS = ['setup', 'check'] as const
export type CheckKind = (typeof CHECK_KINDS)[number]

export const MAX_CHECK_STEPS = 12
export const MIN_TIMEOUT_SECONDS = 10
export const MAX_TIMEOUT_SECONDS = 3_600
export const DEFAULT_TIMEOUT_SECONDS = 600

/** A command is one printable line: nothing in it can carry a terminal control sequence. */
const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (value) => !/[\p{Cc}\p{Cf}]/u.test(value),
      'must be one line without control characters',
    )

export const CheckStepInputSchema = z.strictObject({
  kind: z.enum(CHECK_KINDS),
  name: oneLine(60),
  command: oneLine(1_000),
  timeoutSeconds: z
    .number()
    .int()
    .min(MIN_TIMEOUT_SECONDS)
    .max(MAX_TIMEOUT_SECONDS)
    .default(DEFAULT_TIMEOUT_SECONDS),
  enabled: z.boolean().default(true),
})
export type CheckStepInput = z.input<typeof CheckStepInputSchema>

export const CheckSettingsSaveSchema = z.strictObject({
  repoRoot: z.string().min(1).max(1_024),
  /** The person has read that these run agent-written code, unsandboxed, with their access. */
  acknowledged: z.boolean(),
  steps: z.array(CheckStepInputSchema).max(MAX_CHECK_STEPS),
})
export type CheckSettingsSave = z.input<typeof CheckSettingsSaveSchema>

export interface CheckStep {
  id: string
  kind: CheckKind
  name: string
  command: string
  timeoutSeconds: number
  enabled: boolean
}

export interface CheckSettings {
  repoRoot: string
  acknowledged: boolean
  steps: CheckStep[]
}

export type StepState = 'passed' | 'failed' | 'timeout' | 'skipped' | 'error' | 'cancelled'
export type RunState = 'running' | 'passed' | 'failed' | 'error' | 'cancelled'

/** What one step did, exactly as it ran (a later edit to the settings never rewrites it). */
export interface CheckResult {
  position: number
  kind: CheckKind
  name: string
  command: string
  state: StepState
  exitCode: number | null
  durationMs: number
  /** Redacted, and cut off at a size the app can keep and show. */
  output: string
  truncated: boolean
}

/** One run of a project's checks against one commit of a task's work. */
export interface CheckRun {
  id: string
  taskId: string
  /** The commit the checks ran on. */
  commit: string
  trigger: 'auto' | 'manual'
  state: RunState
  startedAt: string
  finishedAt: string | null
  /** Why a run did not go ahead as planned. */
  note: string | null
  results: CheckResult[]
}

/** Where a task stands on verification, for the person reviewing it. */
export interface TaskVerification {
  /** The project the task worked in, or null when it was not isolated. */
  repoRoot: string | null
  repoName: string | null
  /** Checks are set up and acknowledged, so runs happen on submit. */
  configured: boolean
  /** Why nothing has been verified, when that is so. */
  reason: string | null
  latest: CheckRun | null
}
