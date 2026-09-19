import type { FileChange, GitCommit } from '@shared/git'
import type { EventSource } from '@shared/events/schema'
import type { Priority, TaskStatus } from '@shared/missions'
import type { Finding, ReviewState, ReviewVerdict } from '@shared/reviews'
import type { CheckKind, RunState, StepState } from '@shared/verification'

/**
 * Everything Shokuba recorded about one task's work, gathered in one place. It is written out as
 * `evidence.json` and rendered as `report.md`. It holds no full paths (only the project's folder
 * name), no prompts and no terminal transcripts: what an agent said it did is here only as the
 * agent's own claim.
 */
export interface EvidencePack {
  schemaVersion: 1
  generatedAt: string
  shokubaVersion: string
  mission: { id: string; title: string; description: string; status: string }
  task: {
    id: string
    title: string
    description: string
    status: TaskStatus
    priority: Priority
    attempts: number
    assignee: { id: string; name: string; role: string } | null
    dependsOn: Array<{ id: string; title: string; status: TaskStatus }>
    createdAt: string
    startedAt: string | null
    submittedAt: string | null
    completedAt: string | null
    /** What the agent said it did. Their own words; nothing here was checked against them. */
    agentSummary: string | null
    blockedReason: string | null
    /** The note from the last time it was sent back. */
    lastFeedback: string | null
  }
  outcome: {
    accepted: boolean
    acceptedAt: string | null
    /** Who made the accepting decision, as the event log recorded its source. */
    acceptedBy: 'person' | 'other' | null
    /** How many times it was sent back for changes. */
    sentBack: number
  }
  work: WorkRecord
  checks: { runs: CheckRunRecord[]; total: number; headline: string }
  reviews: { reviews: ReviewRecord[]; total: number; headline: string }
  timeline: TimelineEntry[]
  timelineTruncated: boolean
}

export interface WorkRecord {
  /** False when the task ran in the employee's own folder, so there is no branch to show. */
  isolated: boolean
  /** Why it is not isolated, or why its changes could not be read. */
  problem: string | null
  state: 'active' | 'merged' | 'none' | 'removed' | null
  /** The project's folder name (not its full path). */
  project: string | null
  branch: string | null
  missionBranch: string | null
  baseCommit: string | null
  /** Where the task's branch points now: the work as it stands, or as it was accepted. */
  finalCommit: string | null
  mergeCommit: string | null
  workingFolderRemoved: boolean
  commits: GitCommit[]
  commitsTruncated: boolean
  files: FileChange[]
  diff: DiffRecord | null
}

export interface DiffRecord {
  /** The file it is written to, relative to the pack. */
  file: string
  bytes: number
  /** True if the diff was cut at the size limit. */
  truncated: boolean
  /** True if it holds control characters, such as terminal escape sequences. */
  hasControlCharacters: boolean
  /** Kinds of secret-looking text found in it (never the text itself). */
  secretSignals: Array<{ kind: string; count: number }>
}

export interface CheckStepRecord {
  position: number
  kind: CheckKind
  name: string
  command: string
  state: StepState
  exitCode: number | null
  durationMs: number
  outputTruncated: boolean
  /** The file its output is written to, relative to the pack; null if it printed nothing. */
  logFile: string | null
}

export interface CheckRunRecord {
  id: string
  commit: string
  /** Whether it ran on the commit the work ended at, rather than an earlier one; null if that could not be told. */
  onFinalCommit: boolean | null
  trigger: 'auto' | 'manual'
  state: RunState
  startedAt: string
  finishedAt: string | null
  note: string | null
  steps: CheckStepRecord[]
}

export interface ReviewRecord {
  id: string
  reviewer: { id: string; name: string }
  /** The commit the reviewer read. */
  commit: string
  onFinalCommit: boolean | null
  state: ReviewState
  verdict: ReviewVerdict | null
  summary: string | null
  findings: Finding[]
  requestedBy: 'auto' | 'manual'
  createdAt: string
  submittedAt: string | null
  note: string | null
}

export interface TimelineEntry {
  seq: number
  ts: string
  /** How Shokuba came to know it: a person's action, the agent's report, Shokuba's own doing. */
  source: EventSource
  text: string
}

/** Files to write, relative to the pack's folder. */
export interface PackFile {
  path: string
  content: string
}
