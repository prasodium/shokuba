import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { PermissionMode } from '@shared/employees'
import type { EventType, ShokubaEvent } from '@shared/events/schema'
import type { Task } from '@shared/missions'
import {
  ReviewSettingsSaveSchema,
  ReviewSubmitSchema,
  type Finding,
  type FindingSeverity,
  type Review,
  type ReviewSettings,
  type ReviewState,
  type ReviewSubmit,
  type ReviewVerdict,
  type TaskReview,
} from '@shared/reviews'
import type { Db } from '../database/connection'
import type { AuditLog } from '../events/audit'
import type { EventStore } from '../events/store'
import type { GitService } from '../git/service'
import { describeError, type Logger } from '../logging/logger'
import { buildReviewBriefing } from './briefing'

export type ReviewErrorCode = 'invalid' | 'no-review'

export class ReviewError extends Error {
  constructor(
    readonly code: ReviewErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ReviewError'
  }
}

/** What the service needs from the agent runtime, to put a reviewer to work. */
export interface ReviewDelivery {
  deliveryBlocker(employeeId: string): string | null
  deliverPrompt(employeeId: string, text: string): Promise<void>
  cwdOf(employeeId: string): string | undefined
  restartIn(
    employeeId: string,
    cwd: string,
    options?: { permissionMode?: PermissionMode },
  ): Promise<void>
}

export interface ReviewServiceDeps {
  db: Db
  events: EventStore
  audit: AuditLog
  git: GitService | undefined
  missions: { getTask(id: string): Task | undefined; hasActiveTask(employeeId: string): boolean }
  employees: { get(id: string): { id: string; name: string } | undefined }
  workspaces: {
    infoFor(taskId: string): { repoRoot: string; folder: string; branch: string } | undefined
    isolationReason(taskId: string): string | null
    reviewBase(taskId: string): Promise<string | undefined>
    commit(task: Task): Promise<boolean>
  }
  delivery: ReviewDelivery
  /** May this employee be given work now? (The circuit breaker says no to a limited one.) */
  allows?: (employeeId: string) => boolean
  /** Only one thing at a time may move an agent (a task's hand-over, or this). */
  lock: { acquire(employeeId: string): boolean; release(employeeId: string): void }
  /** Ends what a reviewer is doing, when the work they are reading has changed. */
  interrupt?: (employeeId: string) => void
  logger: Logger
  now?: () => Date
  newId?: () => string
}

interface Row {
  id: string
  task_id: string
  mission_id: string
  reviewer_id: string
  repo_root: string
  commit_id: string
  base_commit: string
  state: ReviewState
  verdict: ReviewVerdict | null
  summary: string | null
  requested_by: 'auto' | 'manual'
  worktree_path: string | null
  note: string | null
  folder_removed_at: string | null
  created_at: string
  started_at: string | null
  submitted_at: string | null
}

/** Statuses in which work can be reviewed: the author has stopped changing it. */
const REVIEWABLE: ReadonlySet<string> = new Set(['submitted', 'changes_requested', 'blocked'])
/** Statuses that mean the work being read is about to change or has been dropped. */
const STALE: ReadonlySet<string> = new Set([
  'changes_requested',
  'cancelled',
  'blocked',
  'in_progress',
])
/** Events after which a queued review might be able to go ahead. */
const TRIGGERS: ReadonlySet<EventType> = new Set([
  'agent.state.changed',
  'agent.started',
  'review.changed',
  'breaker.state.changed',
])

const RETRY_COOLDOWN_MS = 5_000
const DIFF_BYTES = 60_000

/**
 * Independent review of a task's work. A different employee reads the diff and what was asked
 * (see `briefing.ts`: never the author's own account), in a folder that is the code as it was
 * submitted, held to plan mode, and reports through `submit_review`. What they say is advice for
 * the person: it does not accept, reject or send back anything.
 *
 * A review is tied to the exact commit it read, so a review of an earlier version is never taken
 * for a review of the latest, and it is dropped if the work changes while it is being read.
 */
export class ReviewService {
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly cooldown = new Map<string, number>()
  private unsubscribe: (() => void) | undefined
  private stopped = false
  private inflight: Promise<void> | null = null
  private again = false

  constructor(private readonly deps: ReviewServiceDeps) {
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? randomUUID
  }

  start(): void {
    if (this.unsubscribe) return
    this.stopped = false
    // A reviewer that was reading when Shokuba stopped is gone; the review cannot be finished.
    this.deps.db
      .prepare(
        "UPDATE reviews SET state = 'error', note = 'Shokuba stopped while this was being reviewed' WHERE state = 'in_progress'",
      )
      .run()
    this.unsubscribe = this.deps.events.bus.onAny((event) => this.onEvent(event))
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  // ---------- settings ----------

  getSettings(repoRoot: string): ReviewSettings {
    const row = this.deps.db
      .prepare('SELECT reviewer_id, auto FROM review_settings WHERE repo_root = ?')
      .get(repoRoot) as { reviewer_id: string | null; auto: number } | undefined
    return { repoRoot, reviewerId: row?.reviewer_id ?? null, auto: row?.auto === 1 }
  }

  saveSettings(raw: unknown): ReviewSettings {
    const parsed = ReviewSettingsSaveSchema.safeParse(raw)
    if (!parsed.success)
      throw new ReviewError('invalid', parsed.error.issues[0]?.message ?? 'Invalid settings')
    const { repoRoot, reviewerId, auto } = parsed.data
    if (reviewerId !== null && !this.deps.employees.get(reviewerId)) {
      throw new ReviewError('invalid', 'That employee does not exist.')
    }
    this.deps.db
      .prepare(
        `INSERT INTO review_settings (repo_root, reviewer_id, auto, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (repo_root) DO UPDATE SET reviewer_id = excluded.reviewer_id, auto = excluded.auto, updated_at = excluded.updated_at`,
      )
      .run(repoRoot, reviewerId, auto && reviewerId !== null ? 1 : 0, this.stamp())
    return this.getSettings(repoRoot)
  }

  // ---------- asking for a review ----------

  /**
   * Ask for a review of a task's work. The reviewer must be someone other than its author; the
   * work is saved as a commit first, so the review names exactly what was read.
   */
  async request(taskId: string, reviewerId: string | null, by: 'auto' | 'manual'): Promise<void> {
    const { git, workspaces, missions } = this.deps
    const task = missions.getTask(taskId)
    const info = workspaces.infoFor(taskId)
    if (!task || !info || !git) {
      throw new ReviewError('invalid', 'That task has no working folder of its own to review.')
    }
    if (!REVIEWABLE.has(task.status)) {
      throw new ReviewError(
        'invalid',
        'The work can only be reviewed once the agent has submitted it.',
      )
    }
    const chosen = reviewerId ?? this.getSettings(info.repoRoot).reviewerId
    if (!chosen) throw new ReviewError('invalid', 'Choose who should review it.')
    if (!this.deps.employees.get(chosen)) {
      throw new ReviewError('invalid', 'That employee does not exist.')
    }
    if (chosen === task.assigneeId) {
      throw new ReviewError(
        'invalid',
        'The author cannot review their own work: choose someone else.',
      )
    }
    const open = this.deps.db
      .prepare(
        "SELECT 1 FROM reviews WHERE task_id = ? AND state IN ('queued', 'in_progress') LIMIT 1",
      )
      .get(taskId)
    if (open !== undefined) {
      throw new ReviewError('invalid', 'A review of this task is already under way.')
    }
    if (!(await workspaces.commit(task))) {
      throw new ReviewError(
        'invalid',
        'The agent’s work could not be saved as a commit, so it cannot be reviewed yet.',
      )
    }
    const commit = await git.resolve(info.repoRoot, info.branch)
    const base = await workspaces.reviewBase(taskId)
    if (!commit || !base) throw new ReviewError('invalid', 'The task’s work could not be found.')

    const id = this.newId()
    this.deps.db
      .prepare(
        `INSERT INTO reviews (id, task_id, mission_id, reviewer_id, repo_root, commit_id, base_commit, state, requested_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(id, task.id, task.missionId, chosen, info.repoRoot, commit, base, by, this.stamp())
    this.publish(task, id, chosen, { change: 'requested', commit })
    this.deps.audit.record({
      actor: by === 'manual' ? 'user' : 'system',
      action: 'review.request',
      target: task.id,
      detail: { reviewId: id, reviewerId: chosen, commit },
    })
    this.schedule()
  }

  // ---------- what the reviewer does ----------

  /** Whether this employee has a review they are reading right now. */
  hasActive(employeeId: string): boolean {
    return (
      this.deps.db
        .prepare("SELECT 1 FROM reviews WHERE reviewer_id = ? AND state = 'in_progress' LIMIT 1")
        .get(employeeId) !== undefined
    )
  }

  /** The briefing for the review this employee is reading, read fresh; null if they have none. */
  async current(employeeId: string): Promise<string | null> {
    const row = this.activeRow(employeeId)
    if (!row) return null
    return (await this.briefing(row)) ?? null
  }

  /** The reviewer hands in what they found. Only the review they are reading can be answered. */
  submit(employeeId: string, raw: ReviewSubmit): Review {
    const parsed = ReviewSubmitSchema.safeParse(raw)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const where = issue?.path.map(String).join('.')
      throw new ReviewError(
        'invalid',
        where ? `${where}: ${issue?.message}` : (issue?.message ?? 'Invalid review'),
      )
    }
    const row = this.activeRow(employeeId)
    if (!row) {
      throw new ReviewError(
        'no-review',
        'You have no review in progress. If one was cancelled because the work changed, there is nothing more to do.',
      )
    }
    const { verdict, summary, findings } = parsed.data
    const ts = this.stamp()
    this.deps.db.transaction(() => {
      this.deps.db
        .prepare(
          "UPDATE reviews SET state = 'submitted', verdict = ?, summary = ?, submitted_at = ? WHERE id = ?",
        )
        .run(verdict, summary, ts, row.id)
      const insert = this.deps.db.prepare(
        'INSERT INTO review_findings (review_id, position, severity, file, line, note) VALUES (?, ?, ?, ?, ?, ?)',
      )
      findings.forEach((f, position) =>
        insert.run(row.id, position, f.severity, f.file ?? null, f.line ?? null, f.note),
      )
    })()
    const task = this.deps.missions.getTask(row.task_id)
    if (task)
      this.publish(task, row.id, row.reviewer_id, {
        change: 'submitted',
        verdict,
        commit: row.commit_id,
      })
    this.deps.audit.record({
      actor: row.reviewer_id,
      action: 'review.submit',
      target: row.task_id,
      detail: { reviewId: row.id, verdict, findings: findings.length, commit: row.commit_id },
    })
    return this.mustReview(row.id)
  }

  // ---------- what a person sees ----------

  async forTask(taskId: string): Promise<TaskReview> {
    const info = this.deps.workspaces.infoFor(taskId)
    const latest = this.latestRow(taskId)
    const repoRoot = info?.repoRoot ?? latest?.repo_root ?? null
    if (repoRoot === null) {
      const reason = this.deps.workspaces.isolationReason(taskId)
      return {
        repoRoot: null,
        settings: null,
        reason: reason
          ? `It was not worked on in its own folder (${reason}), so there is nothing to review.`
          : null,
        latest: null,
        outOfDate: false,
      }
    }
    let outOfDate = false
    if (latest && info && this.deps.git) {
      const now = await this.deps.git.resolve(info.repoRoot, info.branch)
      outOfDate = now !== null && now !== latest.commit_id
    }
    return {
      repoRoot,
      settings: this.getSettings(repoRoot),
      reason: null,
      latest: latest ? this.toReview(latest) : null,
      outOfDate,
    }
  }

  /**
   * Every review of a task, oldest first, for the record of what was said about it. If there are
   * more than `limit`, the newest are kept and `total` says how many there were.
   */
  history(taskId: string, limit = 20): { reviews: Review[]; total: number } {
    const { n } = this.deps.db
      .prepare('SELECT COUNT(*) AS n FROM reviews WHERE task_id = ?')
      .get(taskId) as { n: number }
    const rows = this.deps.db
      .prepare(
        `SELECT * FROM (
           SELECT rowid AS r, * FROM reviews WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
         ) ORDER BY created_at ASC, r ASC`,
      )
      .all(taskId, limit) as Row[]
    return { reviews: rows.map((row) => this.toReview(row)), total: n }
  }

  // ---------- going ahead ----------

  private onEvent(event: ShokubaEvent): void {
    if (event.type === 'task.status.changed') {
      const { taskId, to } = event.payload
      if (to === 'submitted') {
        void this.autoRequest(taskId)
      } else if (STALE.has(to)) {
        this.cancelFor(taskId, 'The work changed while it was being reviewed.')
      }
      return
    }
    if (TRIGGERS.has(event.type)) this.schedule()
  }

  /** Ask for a review by itself, if the project is set up for that. A refusal is not an error. */
  private async autoRequest(taskId: string): Promise<void> {
    const info = this.deps.workspaces.infoFor(taskId)
    if (!info) return
    const settings = this.getSettings(info.repoRoot)
    if (!settings.auto || !settings.reviewerId) return
    try {
      await this.request(taskId, settings.reviewerId, 'auto')
    } catch (error) {
      if (!(error instanceof ReviewError)) {
        this.deps.logger.warn('review.auto.failed', { taskId, ...describeError(error) })
      }
    }
  }

  /** Drop any review of this task that has not finished: the work it is about has gone. */
  private cancelFor(taskId: string, note: string): void {
    const open = this.deps.db
      .prepare("SELECT * FROM reviews WHERE task_id = ? AND state IN ('queued', 'in_progress')")
      .all(taskId) as Row[]
    for (const row of open) {
      this.deps.db
        .prepare("UPDATE reviews SET state = 'cancelled', note = ? WHERE id = ?")
        .run(note, row.id)
      const task = this.deps.missions.getTask(taskId)
      if (task) this.publish(task, row.id, row.reviewer_id, { change: 'cancelled' })
      if (row.state === 'in_progress') this.deps.interrupt?.(row.reviewer_id)
    }
  }

  private schedule(): void {
    queueMicrotask(() => {
      if (this.unsubscribe) this.tick().catch((error: unknown) => this.log(error))
    })
  }

  /**
   * One pass over the queued reviews. If a pass is already under way it is asked to go round
   * again, and the caller gets that same pass: when it settles, everything asked for so far
   * has been looked at.
   */
  tick(): Promise<void> {
    if (this.inflight) {
      this.again = true
      return this.inflight
    }
    const run = (async () => {
      do {
        this.again = false
        await this.pass()
      } while (this.again && !this.stopped)
    })().finally(() => {
      this.inflight = null
    })
    this.inflight = run
    return run
  }

  private async pass(): Promise<void> {
    if (this.stopped) return
    const now = this.now().getTime()
    const queued = this.deps.db
      .prepare("SELECT * FROM reviews WHERE state = 'queued' ORDER BY created_at, rowid")
      .all() as Row[]
    for (const row of queued) {
      if (this.stopped) return
      const task = this.deps.missions.getTask(row.task_id)
      if (!task || STALE.has(task.status)) {
        this.cancelFor(row.task_id, 'The work changed before it could be reviewed.')
        continue
      }
      const reviewer = row.reviewer_id
      if ((this.cooldown.get(row.id) ?? 0) > now) continue
      if (this.deps.missions.hasActiveTask(reviewer) || this.hasActive(reviewer)) continue
      if (this.deps.delivery.deliveryBlocker(reviewer) !== null) continue
      if (this.deps.allows && !this.deps.allows(reviewer)) continue
      if (!this.deps.lock.acquire(reviewer)) continue
      try {
        await this.handOver(row, task, now)
      } finally {
        this.deps.lock.release(reviewer)
      }
    }
  }

  /** Put the reviewer where the code is, in plan mode, and hand them the review. */
  private async handOver(row: Row, task: Task, now: number): Promise<void> {
    const { git, delivery } = this.deps
    if (!git) return
    let claimed = false
    try {
      const dir = git.worktreePath(row.repo_root, `review-${row.id}`)
      if (!(await exists(dir))) await git.createDetachedWorktree(row.repo_root, dir, row.commit_id)
      const briefing = await this.briefing(row, dir)
      if (!briefing) throw new Error('The review could not be prepared.')

      // Held to plan mode whatever the employee's own setting is; nothing they change is kept.
      if (delivery.cwdOf(row.reviewer_id) !== (await fs.realpath(dir))) {
        await delivery.restartIn(row.reviewer_id, dir, { permissionMode: 'plan' })
      }
      if (this.stopped || delivery.deliveryBlocker(row.reviewer_id) !== null) return

      const result = this.deps.db
        .prepare(
          "UPDATE reviews SET state = 'in_progress', started_at = ?, worktree_path = ? WHERE id = ? AND state = 'queued'",
        )
        .run(this.stamp(), dir, row.id)
      if (result.changes !== 1) return // the work changed, and it was cancelled
      claimed = true
      this.publish(task, row.id, row.reviewer_id, { change: 'started' })
      await delivery.deliverPrompt(row.reviewer_id, briefing)
      this.cooldown.delete(row.id)
    } catch (error) {
      const { message } = describeError(error)
      this.deps.logger.warn('review.handover.failed', { reviewId: row.id, message })
      if (claimed) {
        this.deps.db
          .prepare(
            "UPDATE reviews SET state = 'queued', started_at = NULL WHERE id = ? AND state = 'in_progress'",
          )
          .run(row.id)
      }
      this.cooldown.set(row.id, now + RETRY_COOLDOWN_MS)
      setTimeout(() => this.schedule(), RETRY_COOLDOWN_MS + 50).unref?.()
    }
  }

  /** The text the reviewer is given, built from the code as submitted. Null if it cannot be. */
  private async briefing(row: Row, folder?: string): Promise<string | null> {
    const { git } = this.deps
    const task = this.deps.missions.getTask(row.task_id)
    if (!git || !task) return null
    const dir = folder ?? row.worktree_path ?? git.worktreePath(row.repo_root, `review-${row.id}`)
    const files = await git.changedFiles(row.repo_root, row.base_commit, row.commit_id)
    const { text, truncated } = await git.diff(
      row.repo_root,
      row.base_commit,
      row.commit_id,
      DIFF_BYTES,
    )
    return buildReviewBriefing({
      title: task.title,
      description: task.description,
      folder: dir,
      base: row.base_commit,
      commit: row.commit_id,
      files,
      diff: text,
      diffTruncated: truncated,
    })
  }

  // ---------- cleaning up ----------

  /** Reading folders that are due to go: the review is over. */
  pendingRemoval(): Array<{ key: string; folder: string }> {
    const rows = this.deps.db
      .prepare(
        "SELECT id, worktree_path FROM reviews WHERE worktree_path IS NOT NULL AND folder_removed_at IS NULL AND state IN ('submitted', 'cancelled', 'error')",
      )
      .all() as Array<{ id: string; worktree_path: string }>
    return rows.map((row) => ({ key: row.id, folder: row.worktree_path }))
  }

  async removeFolder(reviewId: string): Promise<boolean> {
    const { git } = this.deps
    const row = this.deps.db.prepare('SELECT * FROM reviews WHERE id = ?').get(reviewId) as
      Row | undefined
    if (!git || !row?.worktree_path || row.folder_removed_at) return false
    try {
      await git.removeWorktree(row.repo_root, row.worktree_path)
      this.deps.db
        .prepare('UPDATE reviews SET folder_removed_at = ? WHERE id = ?')
        .run(this.stamp(), reviewId)
      return true
    } catch (error) {
      this.deps.logger.warn('review.remove.failed', { reviewId, ...describeError(error) })
      return false
    }
  }

  // ---------- reading ----------

  private activeRow(employeeId: string): Row | undefined {
    return this.deps.db
      .prepare(
        "SELECT * FROM reviews WHERE reviewer_id = ? AND state = 'in_progress' ORDER BY started_at DESC LIMIT 1",
      )
      .get(employeeId) as Row | undefined
  }

  private latestRow(taskId: string): Row | undefined {
    return this.deps.db
      .prepare(
        'SELECT * FROM reviews WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      )
      .get(taskId) as Row | undefined
  }

  private mustReview(id: string): Review {
    const row = this.deps.db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as Row
    return this.toReview(row)
  }

  private toReview(row: Row): Review {
    const findings = this.deps.db
      .prepare('SELECT * FROM review_findings WHERE review_id = ? ORDER BY position')
      .all(row.id) as Array<{
      severity: FindingSeverity
      file: string | null
      line: number | null
      note: string
    }>
    return {
      id: row.id,
      taskId: row.task_id,
      reviewerId: row.reviewer_id,
      commit: row.commit_id,
      state: row.state,
      verdict: row.verdict,
      summary: row.summary,
      findings: findings.map((f): Finding => ({
        severity: f.severity,
        file: f.file,
        line: f.line,
        note: f.note,
      })),
      requestedBy: row.requested_by,
      createdAt: row.created_at,
      startedAt: row.started_at,
      submittedAt: row.submitted_at,
      note: row.note,
    }
  }

  private publish(
    task: Task,
    reviewId: string,
    reviewerId: string,
    detail: {
      change: 'requested' | 'started' | 'submitted' | 'cancelled' | 'error'
      verdict?: ReviewVerdict
      commit?: string
    },
  ): void {
    this.deps.events.publish({
      type: 'review.changed',
      source: 'system',
      missionId: task.missionId,
      taskId: task.id,
      payload: { taskId: task.id, missionId: task.missionId, reviewId, reviewerId, ...detail },
    })
  }

  private log(error: unknown): void {
    this.deps.logger.error('review.pass.failed', describeError(error))
  }

  private stamp(): string {
    return this.now().toISOString()
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}
