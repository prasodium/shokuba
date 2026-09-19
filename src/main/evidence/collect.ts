import type { ShokubaEvent } from '@shared/events/schema'
import type { Mission, Task } from '@shared/missions'
import type { CheckRun } from '@shared/verification'
import type { Review } from '@shared/reviews'
import type { ListOptions } from '../events/log'
import type { GitService } from '../git/service'
import { describeError, type Logger } from '../logging/logger'
import { pathApi, type PlatformId } from '../platform'
import { redactDeep, redactString, scanSecrets } from '../security/redact'
import type { WorkspaceEvidence } from '../workspaces/service'
import { scrubPaths, slug } from './markdown'
import { checksHeadline, outcomeOf, reviewsHeadline, timelineOf } from './summary'
import type { CheckRunRecord, DiffRecord, EvidencePack, ReviewRecord, WorkRecord } from './types'

export class EvidenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvidenceError'
  }
}

/** The most of a diff kept in a pack; a bigger one is cut here and the pack says so. */
export const EVIDENCE_DIFF_BYTES = 5_000_000
const COMMIT_LIMIT = 200
const RUN_LIMIT = 20
const REVIEW_LIMIT = 20
const EVENT_PAGE = 1_000
const EVENT_PAGES = 20

export interface EvidenceDeps {
  missions: { getTask(id: string): Task | undefined; getMission(id: string): Mission | undefined }
  employees: { get(id: string): { id: string; name: string; role: string } | undefined }
  events: { list(options: ListOptions): ShokubaEvent[] }
  workspaces: { evidenceFor(taskId: string): Promise<WorkspaceEvidence | undefined> }
  git: GitService | undefined
  verification: { history(taskId: string, limit?: number): { runs: CheckRun[]; total: number } }
  reviews: { history(taskId: string, limit?: number): { reviews: Review[]; total: number } }
  platform: PlatformId
  shokubaVersion: string
  logger: Logger
  now?: () => Date
}

/** A pack and the files that go with it: the diff and the output of each step of each check. */
export interface CollectedEvidence {
  pack: EvidencePack
  /** The diff exactly as Git produced it, or null if there is none. */
  diff: string | null
  /** The output of each step, by the file it is written to. */
  logs: Array<{ path: string; content: string }>
}

/** A time as UTC, so the pack never carries the timezone of the machine that made a commit. */
export function utc(time: string): string {
  const date = new Date(time)
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toISOString()
}

/** Whether text holds a control character other than the ordinary line and tab ones. */
export function hasControlCharacters(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      return true
    }
  }
  return false
}

/**
 * Gathers what Shokuba recorded about one task's work: what was asked, what the agent said it
 * did, the commits and the diff, every run of the checks, every review, who accepted it, and a
 * timeline from the event log. It only reads; nothing here changes a task, a branch or a file.
 *
 * Text is redacted of secret-looking values (by pattern, as everywhere in Shokuba) with one
 * exception: the diff is the code exactly as Git produced it, so it is scanned instead, and the
 * pack says what it found without repeating it.
 */
export class EvidenceCollector {
  private readonly now: () => Date

  constructor(private readonly deps: EvidenceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  async collect(taskId: string): Promise<CollectedEvidence> {
    const task = this.deps.missions.getTask(taskId)
    const mission = task && this.deps.missions.getMission(task.missionId)
    if (!task || !mission) throw new EvidenceError('That task does not exist.')

    const nameOf = (id: string): string => this.deps.employees.get(id)?.name ?? 'a removed employee'
    const events = this.taskEvents(taskId)
    const { work, diff } = await this.workOf(task)

    const { runs, total: runTotal } = this.deps.verification.history(taskId, RUN_LIMIT)
    const logs: Array<{ path: string; content: string }> = []
    const runRecords = runs.map((run, index) => this.runRecord(run, index, work.finalCommit, logs))

    const { reviews, total: reviewTotal } = this.deps.reviews.history(taskId, REVIEW_LIMIT)
    const reviewRecords = reviews.map((review): ReviewRecord => ({
      id: review.id,
      reviewer: { id: review.reviewerId, name: nameOf(review.reviewerId) },
      commit: review.commit,
      onFinalCommit: work.finalCommit === null ? null : review.commit === work.finalCommit,
      state: review.state,
      verdict: review.verdict,
      summary: review.summary,
      findings: review.findings,
      requestedBy: review.requestedBy,
      createdAt: review.createdAt,
      submittedAt: review.submittedAt,
      note: review.note,
    }))

    const assignee = task.assigneeId ? this.deps.employees.get(task.assigneeId) : undefined
    const timeline = timelineOf(events, nameOf)
    const pack: EvidencePack = {
      schemaVersion: 1,
      generatedAt: this.now().toISOString(),
      shokubaVersion: this.deps.shokubaVersion,
      mission: {
        id: mission.id,
        title: mission.title,
        description: mission.description,
        status: mission.status,
      },
      task: {
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        attempts: task.attempts,
        assignee: assignee ? { id: assignee.id, name: assignee.name, role: assignee.role } : null,
        dependsOn: task.dependsOn.flatMap((id) => {
          const dependency = this.deps.missions.getTask(id)
          return dependency ? [{ id, title: dependency.title, status: dependency.status }] : []
        }),
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        submittedAt: task.submittedAt,
        completedAt: task.completedAt,
        agentSummary: task.summary,
        blockedReason: task.blockedReason,
        lastFeedback: task.reviewNote,
      },
      outcome: outcomeOf(events, task.status, task.completedAt),
      work,
      checks: { runs: runRecords, total: runTotal, headline: checksHeadline(runRecords) },
      reviews: {
        reviews: reviewRecords,
        total: reviewTotal,
        headline: reviewsHeadline(reviewRecords),
      },
      timeline: timeline.entries,
      timelineTruncated: timeline.truncated,
    }

    // Everything but the diff and the logs is redacted of secret-looking values; the logs already
    // were when they were kept, and are done again here so a pack never depends on that.
    return {
      pack: redactDeep(pack),
      diff,
      logs: logs.map((log) => ({ path: log.path, content: redactString(log.content) })),
    }
  }

  /** Every event about the task, oldest first. */
  private taskEvents(taskId: string): ShokubaEvent[] {
    const all: ShokubaEvent[] = []
    let after = 0
    for (let page = 0; page < EVENT_PAGES; page += 1) {
      const events = this.deps.events.list({ taskId, afterSeq: after, limit: EVENT_PAGE })
      all.push(...events)
      const last = events.at(-1)
      if (!last || events.length < EVENT_PAGE) break
      after = last.seq
    }
    return all
  }

  private runRecord(
    run: CheckRun,
    index: number,
    finalCommit: string | null,
    logs: Array<{ path: string; content: string }>,
  ): CheckRunRecord {
    return {
      id: run.id,
      commit: run.commit,
      onFinalCommit: finalCommit === null || run.commit === '' ? null : run.commit === finalCommit,
      trigger: run.trigger,
      state: run.state,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      note: run.note,
      steps: run.results.map((result) => {
        // The file name is made here from numbers and a plain version of the step's name, never
        // from anything that could point somewhere else.
        const path = `checks/run-${index + 1}-step-${result.position + 1}-${slug(result.name, 30)}.log`
        if (result.output !== '') logs.push({ path, content: result.output })
        return {
          position: result.position,
          kind: result.kind,
          name: result.name,
          command: result.command,
          state: result.state,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          outputTruncated: result.truncated,
          logFile: result.output === '' ? null : path,
        }
      }),
    }
  }

  /** Where the work is and what it changed. A problem reading Git becomes a note, never a failure. */
  private async workOf(task: Task): Promise<{ work: WorkRecord; diff: string | null }> {
    const { git, workspaces, logger } = this.deps
    const empty: WorkRecord = {
      isolated: false,
      problem: null,
      state: null,
      project: null,
      branch: null,
      missionBranch: null,
      baseCommit: null,
      finalCommit: null,
      mergeCommit: null,
      workingFolderRemoved: false,
      commits: [],
      commitsTruncated: false,
      files: [],
      diff: null,
    }
    const evidence = await workspaces.evidenceFor(task.id)
    if (!evidence) {
      return { work: { ...empty, problem: 'The task was never handed to an agent.' }, diff: null }
    }
    const work: WorkRecord = {
      ...empty,
      state: evidence.state,
      project: evidence.repoRoot ? pathApi(this.deps.platform).basename(evidence.repoRoot) : null,
      branch: evidence.branch,
      missionBranch: evidence.missionBranch,
      baseCommit: evidence.baseCommit,
      finalCommit: evidence.headCommit,
      mergeCommit: evidence.mergeCommit,
      workingFolderRemoved: evidence.folderRemoved,
    }
    if (evidence.state === 'none') {
      return {
        work: {
          ...work,
          problem: `It ran in the employee's own folder, not its own branch${evidence.note ? ` (${scrubPaths(evidence.note)})` : ''}, so there is no diff to show.`,
        },
        diff: null,
      }
    }
    if (!git || !evidence.repoRoot || !evidence.branch || !evidence.compareBase) {
      return { work: { ...work, problem: 'Git could not be used to read the work.' }, diff: null }
    }
    try {
      const { repoRoot, branch, compareBase } = evidence
      const [{ commits, truncated }, files, changes] = await Promise.all([
        git.commits(repoRoot, compareBase, branch, COMMIT_LIMIT),
        git.changedFiles(repoRoot, compareBase, branch),
        git.diff(repoRoot, compareBase, branch, EVIDENCE_DIFF_BYTES),
      ])
      const record: DiffRecord | null =
        changes.text === ''
          ? null
          : {
              file: 'changes.diff',
              bytes: Buffer.byteLength(changes.text),
              truncated: changes.truncated,
              hasControlCharacters: hasControlCharacters(changes.text),
              secretSignals: scanSecrets(changes.text),
            }
      return {
        work: {
          ...work,
          isolated: true,
          commits: commits.map((commit) => ({ ...commit, date: utc(commit.date) })),
          commitsTruncated: truncated,
          files,
          diff: record,
        },
        diff: record ? changes.text : null,
      }
    } catch (error) {
      logger.warn('evidence.work.failed', { taskId: task.id, ...describeError(error) })
      return { work: { ...work, problem: 'The changes could not be read from Git.' }, diff: null }
    }
  }
}
