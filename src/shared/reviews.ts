import { z } from 'zod'

/**
 * An independent review of a task's work: a different employee reads the diff and the task's
 * requirements (never the author's own account of what they did) and reports what they found.
 * The verdict is advice. Only a person accepts a task.
 */
export const REVIEW_VERDICTS = ['approve', 'request_changes', 'comment'] as const
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number]

export const FINDING_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number]

export const MAX_FINDINGS = 50

/** Text written by an agent that ends up in the app and in a report: printable, bounded. */
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (value) => !/[\p{Cc}\p{Cf}]/u.test(value.replace(/[\n\t]/g, '')),
      'must not contain control characters',
    )

export const FindingInputSchema = z.strictObject({
  severity: z.enum(FINDING_SEVERITIES),
  /** The file it is about, as the reviewer names it. Shown as text, never opened. */
  file: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), 'must be a plain file name')
    .optional(),
  line: z.number().int().min(1).max(1_000_000).optional(),
  note: text(1_000),
})
export type FindingInput = z.input<typeof FindingInputSchema>

export const ReviewSubmitSchema = z.strictObject({
  verdict: z.enum(REVIEW_VERDICTS),
  summary: text(4_000),
  findings: z.array(FindingInputSchema).max(MAX_FINDINGS).default([]),
})
export type ReviewSubmit = z.input<typeof ReviewSubmitSchema>

export const ReviewSettingsSaveSchema = z.strictObject({
  repoRoot: z.string().min(1).max(1_024),
  /** Who reviews this project's work; null for nobody. */
  reviewerId: z.string().min(1).max(100).nullable(),
  /** Ask for a review as soon as an agent submits work. */
  auto: z.boolean(),
})
export type ReviewSettingsSave = z.infer<typeof ReviewSettingsSaveSchema>

export type ReviewState = 'queued' | 'in_progress' | 'submitted' | 'cancelled' | 'error'

export interface Finding {
  severity: FindingSeverity
  file: string | null
  line: number | null
  note: string
}

export interface Review {
  id: string
  taskId: string
  reviewerId: string
  /** The commit that was reviewed. */
  commit: string
  state: ReviewState
  verdict: ReviewVerdict | null
  summary: string | null
  findings: Finding[]
  requestedBy: 'auto' | 'manual'
  createdAt: string
  startedAt: string | null
  submittedAt: string | null
  /** Why a review did not go ahead as planned. */
  note: string | null
}

export interface ReviewSettings {
  repoRoot: string
  reviewerId: string | null
  auto: boolean
}

/** Where a task stands on review, for the person deciding about it. */
export interface TaskReview {
  /** The project the task worked in, or null when it was not isolated. */
  repoRoot: string | null
  settings: ReviewSettings | null
  /** Why no review can be asked for, when that is so. */
  reason: string | null
  latest: Review | null
  /** True when the work has changed since the review was made. */
  outOfDate: boolean
}
