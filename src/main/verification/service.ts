import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { EventStore } from '../events/store'
import type { ShokubaEvent } from '@shared/events/schema'
import type { Task } from '@shared/missions'
import type {
  CheckKind,
  CheckResult,
  CheckRun,
  CheckStep,
  CheckStepInput,
  RunState,
  StepState,
  TaskVerification,
} from '@shared/verification'
import type { Db } from '../database/connection'
import type { AuditLog } from '../events/audit'
import type { GitService } from '../git/service'
import { describeError, type Logger } from '../logging/logger'
import { pathApi, type Env, type PlatformId } from '../platform'
import { runStep } from './runner'
import { CheckError, type CheckSettingsStore } from './settings'
import { suggestChecks } from './suggest'

/** What the service needs from the workspace service. */
export interface VerificationWorkspaces {
  infoFor(taskId: string): { repoRoot: string; folder: string; branch: string } | undefined
  isolationReason(taskId: string): string | null
  /** Save whatever is uncommitted, so the checks run on a commit. False if it could not be saved. */
  commit(task: Task): Promise<boolean>
}

export interface VerificationServiceDeps {
  db: Db
  events: EventStore
  audit: AuditLog
  settings: CheckSettingsStore
  /** Git, or undefined when it cannot be used (then nothing is isolated, so nothing is verified). */
  git: GitService | undefined
  missions: { getTask(id: string): Task | undefined }
  workspaces: VerificationWorkspaces
  platform: PlatformId
  env: Env
  logger: Logger
  /** Replaced in tests; the real one runs the command. */
  run?: typeof runStep
  now?: () => Date
  newId?: () => string
}

interface Queued {
  taskId: string
  trigger: 'auto' | 'manual'
}

interface RunRow {
  id: string
  task_id: string
  commit_id: string
  trigger: 'auto' | 'manual'
  state: RunState
  note: string | null
  started_at: string
  finished_at: string | null
}

interface ResultRow {
  position: number
  kind: CheckKind
  name: string
  command: string
  state: StepState
  exit_code: number | null
  duration_ms: number
  output: string
  truncated: number
}

/** Statuses in which a person may ask for checks again: the agent has stopped changing things. */
const RUNNABLE: ReadonlySet<string> = new Set(['submitted', 'changes_requested', 'blocked'])
/** Statuses that mean the work being checked is about to change or has been dropped. */
const STALE: ReadonlySet<string> = new Set([
  'changes_requested',
  'cancelled',
  'blocked',
  'in_progress',
])

/**
 * Runs the checks a person has set up on the work an agent submits, and keeps what happened.
 *
 * Every run is tied to one commit, and each step is stored as it ran, so the record says exactly
 * what was verified. One run happens at a time (they compete for the same machine), and a run is
 * dropped if its task is sent back or cancelled, because the work it is checking has gone.
 * Nothing here decides whether work is good: it reports what the commands did.
 */
export class VerificationService {
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly execute: typeof runStep
  private readonly queue: Queued[] = []
  private current: { taskId: string; folder: string; abort: AbortController } | undefined
  private pumping = false
  private stopped = false
  private unsubscribe: (() => void) | undefined

  constructor(private readonly deps: VerificationServiceDeps) {
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? randomUUID
    this.execute = deps.run ?? runStep
  }

  start(): void {
    if (this.unsubscribe) return
    this.stopped = false
    // A run that was under way when Shokuba stopped did not finish, and must not pretend to have.
    this.deps.db
      .prepare(
        "UPDATE check_runs SET state = 'error', note = 'Shokuba stopped while this was running', finished_at = ? WHERE state = 'running'",
      )
      .run(this.stamp())
    this.unsubscribe = this.deps.events.bus.onAny((event) => this.onEvent(event))
  }

  stop(): void {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.queue.length = 0
    this.current?.abort.abort()
  }

  /** Folders a run is using right now, so cleaning up leaves them alone. */
  activeFolders(): string[] {
    return this.current ? [this.current.folder] : []
  }

  // ---------- what a person sees ----------

  async forTask(taskId: string): Promise<TaskVerification> {
    const info = this.deps.workspaces.infoFor(taskId)
    const latest = this.latestRun(taskId)
    const repoRoot = info?.repoRoot ?? latest?.repoRoot ?? null
    if (repoRoot === null) {
      const reason = this.deps.workspaces.isolationReason(taskId)
      return {
        repoRoot: null,
        repoName: null,
        configured: false,
        reason: reason
          ? `It was not worked on in its own folder (${reason}), so its work cannot be checked.`
          : null,
        latest: null,
      }
    }
    const settings = this.deps.settings.get(repoRoot)
    const configured = this.deps.settings.isReady(repoRoot)
    const reason = configured
      ? null
      : settings.steps.length === 0
        ? 'No checks are set up for this project.'
        : !settings.acknowledged
          ? 'Checks are set up for this project but not switched on.'
          : 'This project has no enabled check.'
    return {
      repoRoot,
      repoName: pathApi(this.deps.platform).basename(repoRoot),
      configured,
      reason,
      latest: latest?.run ?? null,
    }
  }

  /** Suggested checks for a project, read from the person's own checkout. Nothing is saved. */
  async suggest(repoRoot: string): Promise<CheckStepInput[]> {
    const { git } = this.deps
    if (!git) return []
    const { commit } = await git.head(repoRoot)
    const names = await git.topLevelNames(repoRoot, commit)
    const packageJson = names.has('package.json')
      ? await git.showFile(repoRoot, commit, 'package.json')
      : null
    return suggestChecks({ names, packageJson })
  }

  // ---------- running ----------

  /** A person asks for the checks to be run again on a task's work. */
  runNow(taskId: string): void {
    const task = this.deps.missions.getTask(taskId)
    const info = this.deps.workspaces.infoFor(taskId)
    if (!task || !info) throw new CheckError('invalid', 'That task has no working folder to check.')
    if (!RUNNABLE.has(task.status)) {
      throw new CheckError(
        'invalid',
        'The work can only be checked once the agent has submitted it.',
      )
    }
    if (!this.deps.settings.isReady(info.repoRoot)) {
      throw new CheckError('invalid', 'Set up and switch on checks for this project first.')
    }
    if (this.current?.taskId === taskId || this.queue.some((q) => q.taskId === taskId)) {
      throw new CheckError('invalid', 'The checks are already running for this task.')
    }
    this.enqueue({ taskId, trigger: 'manual' })
  }

  private onEvent(event: ShokubaEvent): void {
    if (event.type !== 'task.status.changed') return
    const { taskId, to } = event.payload
    if (to === 'submitted') {
      const info = this.deps.workspaces.infoFor(taskId)
      if (info && this.deps.settings.isReady(info.repoRoot)) {
        this.enqueue({ taskId, trigger: 'auto' })
      }
    } else if (STALE.has(to)) {
      // The work being checked is about to change, or is being dropped: stop checking it.
      const at = this.queue.findIndex((q) => q.taskId === taskId)
      if (at >= 0) this.queue.splice(at, 1)
      if (this.current?.taskId === taskId) this.current.abort.abort()
    }
  }

  private enqueue(item: Queued): void {
    if (this.stopped) return
    if (this.queue.some((q) => q.taskId === item.taskId) || this.current?.taskId === item.taskId) {
      return
    }
    this.queue.push(item)
    void this.pump()
  }

  /** Runs go one after another: they compete for the same machine. */
  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      for (let item = this.queue.shift(); item && !this.stopped; item = this.queue.shift()) {
        try {
          await this.runOne(item)
        } catch (error) {
          this.deps.logger.error('verification.run.failed', {
            taskId: item.taskId,
            ...describeError(error),
          })
        }
      }
    } finally {
      this.pumping = false
    }
  }

  private async runOne(item: Queued): Promise<void> {
    const { git, settings, workspaces } = this.deps
    const task = this.deps.missions.getTask(item.taskId)
    const info = workspaces.infoFor(item.taskId)
    if (!task || !info || !git) return
    // The steps as they are now: what is stored with the run is what actually ran.
    const steps = settings.stepsToRun(info.repoRoot)
    if (steps.length === 0) return

    const abort = new AbortController()
    this.current = { taskId: task.id, folder: info.folder, abort }
    try {
      // Checks run on a commit, so the result says exactly what it verified.
      if (!(await workspaces.commit(task))) {
        this.recordFailedToStart(
          task,
          info.repoRoot,
          item.trigger,
          'The agent’s work could not be saved as a commit, so it was not checked.',
        )
        return
      }
      const commit = await git.resolve(info.repoRoot, info.branch)
      if (!commit) {
        this.recordFailedToStart(
          task,
          info.repoRoot,
          item.trigger,
          'The task’s branch could not be found.',
        )
        return
      }
      if (!(await exists(info.folder))) {
        this.recordFailedToStart(
          task,
          info.repoRoot,
          item.trigger,
          'The task’s working folder is gone.',
        )
        return
      }

      const runId = this.newId()
      this.deps.db
        .prepare(
          `INSERT INTO check_runs (id, task_id, mission_id, repo_root, commit_id, trigger, state, started_at)
           VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
        )
        .run(runId, task.id, task.missionId, info.repoRoot, commit, item.trigger, this.stamp())
      this.publish(task, runId, { change: 'started', state: 'running', commit })
      this.deps.audit.record({
        actor: 'system',
        action: 'checks.run',
        target: task.id,
        detail: { commit, trigger: item.trigger, commands: steps.map((step) => step.command) },
      })

      const { state, setupFailed } = await this.runSteps(
        task,
        runId,
        steps,
        info.folder,
        abort.signal,
      )
      const note =
        state === 'failed' && setupFailed
          ? 'A setup step failed, so the checks could not run.'
          : null
      this.deps.db
        .prepare('UPDATE check_runs SET state = ?, note = ?, finished_at = ? WHERE id = ?')
        .run(state, note, this.stamp(), runId)
      this.publish(task, runId, {
        change: state === 'cancelled' ? 'cancelled' : 'finished',
        state,
        commit,
      })
    } finally {
      this.current = undefined
    }
  }

  private async runSteps(
    task: Task,
    runId: string,
    steps: readonly CheckStep[],
    folder: string,
    signal: AbortSignal,
  ): Promise<{ state: RunState; setupFailed: boolean }> {
    let overall: RunState = 'passed'
    let blocked = false
    for (const [position, step] of steps.entries()) {
      if (signal.aborted) {
        this.storeResult(
          runId,
          position,
          step,
          'cancelled',
          null,
          0,
          'Not run: the checks were cancelled.',
          false,
        )
        overall = 'cancelled'
        continue
      }
      if (blocked) {
        this.storeResult(
          runId,
          position,
          step,
          'skipped',
          null,
          0,
          'Not run: an earlier setup step failed.',
          false,
        )
        continue
      }
      this.publish(task, runId, { change: 'step', step: step.name })
      const outcome = await this.execute(
        { command: step.command, cwd: folder, timeoutMs: step.timeoutSeconds * 1_000 },
        { platform: this.deps.platform, env: this.deps.env },
        signal,
      )
      this.storeResult(
        runId,
        position,
        step,
        outcome.state,
        outcome.exitCode,
        outcome.durationMs,
        outcome.output,
        outcome.truncated,
      )
      if (outcome.state === 'cancelled') {
        overall = 'cancelled'
      } else if (outcome.state !== 'passed') {
        if (overall !== 'cancelled') overall = 'failed'
        // Nothing can be said about the checks if what they need could not be set up.
        if (step.kind === 'setup') blocked = true
      }
    }
    return { state: overall, setupFailed: blocked }
  }

  private storeResult(
    runId: string,
    position: number,
    step: CheckStep,
    state: StepState,
    exitCode: number | null,
    durationMs: number,
    output: string,
    truncated: boolean,
  ): void {
    this.deps.db
      .prepare(
        `INSERT INTO check_results (run_id, position, kind, name, command, state, exit_code, duration_ms, output, truncated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        position,
        step.kind,
        step.name,
        step.command,
        state,
        exitCode,
        durationMs,
        output,
        truncated ? 1 : 0,
      )
  }

  /** A run that could not even begin still leaves a record, so it is not silently missing. */
  private recordFailedToStart(
    task: Task,
    repoRoot: string,
    trigger: 'auto' | 'manual',
    note: string,
  ): void {
    const runId = this.newId()
    const ts = this.stamp()
    this.deps.db
      .prepare(
        `INSERT INTO check_runs (id, task_id, mission_id, repo_root, commit_id, trigger, state, note, started_at, finished_at)
         VALUES (?, ?, ?, ?, '', ?, 'error', ?, ?, ?)`,
      )
      .run(runId, task.id, task.missionId, repoRoot, trigger, note, ts, ts)
    this.publish(task, runId, { change: 'error', state: 'error' })
  }

  // ---------- reading ----------

  private latestRun(taskId: string): { run: CheckRun; repoRoot: string } | undefined {
    const row = this.deps.db
      .prepare(
        'SELECT * FROM check_runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1',
      )
      .get(taskId) as (RunRow & { repo_root: string }) | undefined
    if (!row) return undefined
    const results = this.deps.db
      .prepare('SELECT * FROM check_results WHERE run_id = ? ORDER BY position')
      .all(row.id) as ResultRow[]
    return {
      repoRoot: row.repo_root,
      run: {
        id: row.id,
        taskId: row.task_id,
        commit: row.commit_id,
        trigger: row.trigger,
        state: row.state,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        note: row.note,
        results: results.map((r): CheckResult => ({
          position: r.position,
          kind: r.kind,
          name: r.name,
          command: r.command,
          state: r.state,
          exitCode: r.exit_code,
          durationMs: r.duration_ms,
          output: r.output,
          truncated: r.truncated === 1,
        })),
      },
    }
  }

  private publish(
    task: Task,
    runId: string,
    detail: {
      change: 'started' | 'step' | 'finished' | 'cancelled' | 'error'
      state?: RunState
      commit?: string
      step?: string
    },
  ): void {
    this.deps.events.publish({
      type: 'verification.changed',
      source: 'system',
      missionId: task.missionId,
      taskId: task.id,
      payload: { taskId: task.id, missionId: task.missionId, runId, ...detail },
    })
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
