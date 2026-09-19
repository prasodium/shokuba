import { randomUUID } from 'node:crypto'
import {
  MissionInputSchema,
  MissionUpdateSchema,
  TaskInputSchema,
  TaskUpdateSchema,
  type Mission,
  type MissionAction,
  type MissionDetail,
  type MissionInput,
  type MissionStatus,
  type MissionUpdate,
  type Priority,
  type Task,
  type TaskAction,
  type TaskInput,
  type TaskStatus,
  type TaskUpdate,
} from '@shared/missions'
import { dependentsOf, edgesOf, waitingOrReady, wouldCreateCycle } from '@shared/missions/graph'
import type { EventInput, EventSource } from '@shared/events/schema'
import type { Db } from '../database/connection'
import type { EventStore } from '../events/store'
import { buildBriefing } from './briefing'

export type MissionErrorCode =
  'invalid' | 'not-found' | 'closed' | 'state' | 'cycle' | 'unknown-employee' | 'forbidden'

export class MissionError extends Error {
  constructor(
    readonly code: MissionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MissionError'
  }
}

interface MissionRow {
  id: string
  title: string
  description: string
  status: string
  priority: string
  created_by: string | null
  created_at: string
  updated_at: string
}

interface TaskRow {
  id: string
  mission_id: string
  title: string
  description: string
  status: string
  assignee_id: string | null
  priority: string
  attempts: number
  summary: string | null
  blocked_reason: string | null
  review_note: string | null
  position: number
  created_at: string
  updated_at: string
  started_at: string | null
  submitted_at: string | null
  completed_at: string | null
}

/** Statuses in which a task's content may still be edited. */
const EDITABLE: ReadonlySet<TaskStatus> = new Set([
  'pending',
  'ready',
  'changes_requested',
  'blocked',
])
/** Statuses in which a task has not been started, so its dependencies may change. */
const NOT_STARTED: ReadonlySet<TaskStatus> = new Set(['pending', 'ready'])
const CLOSED: ReadonlySet<TaskStatus> = new Set(['done', 'cancelled'])
const MAX_AGENT_TEXT = 4_000

/** Who caused a change; recorded on the event so the log says how we know. */
export interface Actor {
  source: EventSource
  /** The employee, when an agent did it. */
  employeeId?: string
}
const USER: Actor = { source: 'user' }
const SYSTEM: Actor = { source: 'system' }

export interface MissionServiceDeps {
  db: Db
  events: EventStore
  /** Is this an existing, not-removed employee? */
  employeeExists: (employeeId: string) => boolean
  now?: () => Date
  newId?: () => string
}

/**
 * Missions, tasks and the rules between them. Every status change goes through here, so
 * the rules hold no matter who asks (a person, the dispatcher, or an agent's tool call):
 *
 *  - a task is only `ready` when every dependency is `done`;
 *  - a dependency cycle can never be created;
 *  - an agent submitting a task makes it `submitted` (a claim); only a person makes it `done`;
 *  - an agent may only touch the task it was handed.
 *
 * Changes are written in one transaction and announced as events afterwards, so nothing
 * is ever announced that was not saved.
 */
export class MissionService {
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(private readonly deps: MissionServiceDeps) {
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? randomUUID
  }

  // ---------- reading ----------

  listMissions(): MissionDetail[] {
    const rows = this.deps.db
      .prepare('SELECT * FROM missions WHERE archived_at IS NULL ORDER BY created_at DESC, id')
      .all() as MissionRow[]
    return rows.map((row) => ({ mission: toMission(row), tasks: this.loadTasks(row.id) }))
  }

  getMission(id: string): Mission | undefined {
    const row = this.deps.db
      .prepare('SELECT * FROM missions WHERE id = ? AND archived_at IS NULL')
      .get(id) as MissionRow | undefined
    return row && toMission(row)
  }

  getTask(id: string): Task | undefined {
    const row = this.deps.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      TaskRow | undefined
    return row && this.hydrate([row])[0]
  }

  // ---------- missions ----------

  /** A person creates a mission; a manager's agent may too (as a draft), and the record says so. */
  createMission(raw: MissionInput, actor: Actor = USER): Mission {
    const parsed = MissionInputSchema.safeParse(raw)
    if (!parsed.success) throw new MissionError('invalid', firstIssue(parsed.error))
    const input = parsed.data

    return this.transact((out) => {
      const id = this.newId()
      const ts = this.stamp()
      this.deps.db
        .prepare(
          `INSERT INTO missions (id, title, description, status, priority, created_by, created_at, updated_at)
           VALUES (@id, @title, @description, 'draft', @priority, @createdBy, @ts, @ts)`,
        )
        .run({
          id,
          title: input.title,
          description: input.description,
          priority: input.priority,
          createdBy: actor.employeeId ?? null,
          ts,
        })
      out.push({
        type: 'mission.created',
        source: actor.source,
        ...(actor.employeeId && { actorId: actor.employeeId }),
        missionId: id,
        payload: { missionId: id, title: input.title },
      })
      return this.mustMission(id)
    })
  }

  updateMission(id: string, raw: MissionUpdate): Mission {
    const parsed = MissionUpdateSchema.safeParse(raw)
    if (!parsed.success) throw new MissionError('invalid', firstIssue(parsed.error))
    const patch = parsed.data
    const mission = this.mustMission(id)
    const changed = (Object.keys(patch) as Array<keyof MissionUpdate>).filter(
      (key) => patch[key] !== undefined,
    )
    if (changed.length === 0) return mission
    if (mission.status === 'completed' || mission.status === 'cancelled') {
      throw new MissionError('closed', 'This mission is closed')
    }

    return this.transact((out) => {
      const params: Record<string, string> = { id, ts: this.stamp() }
      const sets = changed.map((key) => {
        params[key] = patch[key] as string
        return `${key} = @${key}`
      })
      this.deps.db
        .prepare(`UPDATE missions SET ${sets.join(', ')}, updated_at = @ts WHERE id = @id`)
        .run(params)
      out.push({
        type: 'mission.updated',
        source: 'user',
        missionId: id,
        payload: { missionId: id, fields: changed },
      })
      return this.mustMission(id)
    })
  }

  /** Run, pause or cancel a mission. Running lets the dispatcher hand out ready tasks. */
  missionAction(id: string, action: MissionAction): Mission {
    const mission = this.mustMission(id)
    const from = mission.status
    const to = MISSION_TRANSITIONS[action][from]
    if (!to) throw new MissionError('state', `A ${from} mission cannot be ${PAST_TENSE[action]}`)

    return this.transact((out) => {
      this.setMissionStatus(out, id, from, to, USER, PAST_TENSE[action])
      if (action === 'cancel') {
        for (const task of this.loadTasks(id)) {
          if (CLOSED.has(task.status)) continue
          this.writeTask(task.id, { status: 'cancelled' })
          out.push(statusEvent(task, task.status, 'cancelled', USER, 'mission cancelled'))
        }
      }
      return this.mustMission(id)
    })
  }

  /** Remove a mission from view. Its history stays in the log. */
  archiveMission(id: string): void {
    const mission = this.mustMission(id)
    if (mission.status === 'running')
      throw new MissionError('state', 'Pause or cancel the mission first')
    if (this.loadTasks(id).some((task) => task.status === 'in_progress')) {
      throw new MissionError('state', 'An agent is still working on one of its tasks')
    }
    this.transact((out) => {
      const ts = this.stamp()
      this.deps.db
        .prepare('UPDATE missions SET archived_at = @ts, updated_at = @ts WHERE id = @id')
        .run({ id, ts })
      out.push({
        type: 'mission.updated',
        source: 'user',
        missionId: id,
        payload: { missionId: id, fields: ['archived'] },
      })
    })
  }

  // ---------- tasks (people) ----------

  createTask(raw: TaskInput, actor: Actor = USER): Task {
    const parsed = TaskInputSchema.safeParse(raw)
    if (!parsed.success) throw new MissionError('invalid', firstIssue(parsed.error))
    const input = parsed.data
    const mission = this.mustMission(input.missionId)
    if (mission.status === 'completed' || mission.status === 'cancelled') {
      throw new MissionError('closed', 'This mission is closed; start a new one')
    }
    this.checkAssignee(input.assigneeId)
    const siblings = this.loadTasks(mission.id)
    this.checkDependencies(input.dependsOn, siblings)

    return this.transact((out) => {
      const id = this.newId()
      const ts = this.stamp()
      const position = siblings.reduce((max, task) => Math.max(max, task.position), 0) + 1
      const status = waitingOrReady(
        { dependsOn: input.dependsOn },
        (dep) => siblings.find((task) => task.id === dep)?.status,
      )
      this.deps.db
        .prepare(
          `INSERT INTO tasks (id, mission_id, title, description, status, assignee_id, priority, position, created_at, updated_at)
           VALUES (@id, @missionId, @title, @description, @status, @assigneeId, @priority, @position, @ts, @ts)`,
        )
        .run({
          id,
          missionId: mission.id,
          title: input.title,
          description: input.description,
          status,
          assigneeId: input.assigneeId,
          priority: input.priority,
          position,
          ts,
        })
      this.writeDependencies(id, input.dependsOn)
      out.push({
        type: 'task.created',
        source: actor.source,
        ...(actor.employeeId && { actorId: actor.employeeId }),
        missionId: mission.id,
        taskId: id,
        payload: { taskId: id, missionId: mission.id, title: input.title },
      })
      if (input.assigneeId) {
        out.push(assignedEvent(id, mission.id, input.assigneeId, actor))
      }
      return this.mustTask(id)
    })
  }

  updateTask(id: string, raw: TaskUpdate): Task {
    const parsed = TaskUpdateSchema.safeParse(raw)
    if (!parsed.success) throw new MissionError('invalid', firstIssue(parsed.error))
    const patch = parsed.data
    const task = this.mustTask(id)
    const changed = (Object.keys(patch) as Array<keyof TaskUpdate>).filter(
      (key) => patch[key] !== undefined,
    )
    if (changed.length === 0) return task
    if (!EDITABLE.has(task.status)) {
      throw new MissionError(
        'state',
        `A task that is ${task.status.replace('_', ' ')} cannot be edited`,
      )
    }
    if (patch.dependsOn !== undefined) {
      if (!NOT_STARTED.has(task.status)) {
        throw new MissionError('state', 'Dependencies can only change before a task starts')
      }
      this.checkDependencies(patch.dependsOn, this.loadTasks(task.missionId), task.id)
    }
    if (patch.assigneeId !== undefined) this.checkAssignee(patch.assigneeId)

    return this.transact((out) => {
      const columns: Record<string, string | number | null> = {}
      if (patch.title !== undefined) columns['title'] = patch.title
      if (patch.description !== undefined) columns['description'] = patch.description
      if (patch.priority !== undefined) columns['priority'] = patch.priority
      if (patch.assigneeId !== undefined) columns['assignee_id'] = patch.assigneeId
      if (Object.keys(columns).length > 0) this.writeTask(id, columns)
      if (patch.dependsOn !== undefined) this.writeDependencies(id, patch.dependsOn)

      out.push({
        type: 'task.updated',
        source: 'user',
        missionId: task.missionId,
        taskId: id,
        payload: { taskId: id, missionId: task.missionId, fields: changed },
      })
      if (patch.assigneeId !== undefined && patch.assigneeId !== task.assigneeId) {
        out.push(assignedEvent(id, task.missionId, patch.assigneeId, USER))
      }
      this.refreshReadiness(out, task.missionId, USER)
      return this.mustTask(id)
    })
  }

  taskAction(id: string, action: TaskAction): Task {
    const task = this.mustTask(id)

    return this.transact((out) => {
      switch (action.action) {
        case 'accept': {
          this.requireStatus(task, ['submitted'], 'Only a submitted task can be accepted')
          this.writeTask(id, { status: 'done', completed_at: this.stamp() })
          out.push(statusEvent(task, task.status, 'done', USER, 'accepted'))
          break
        }
        case 'request-changes': {
          this.requireStatus(task, ['submitted'], 'Only a submitted task can be sent back')
          this.writeTask(id, { status: 'changes_requested', review_note: action.note })
          out.push(statusEvent(task, task.status, 'changes_requested', USER, 'changes requested'))
          break
        }
        case 'retry': {
          this.requireStatus(task, ['blocked'], 'Only a blocked task can be retried')
          this.writeTask(id, { status: 'ready', blocked_reason: null })
          out.push(statusEvent(task, task.status, 'ready', USER, 'retry'))
          break
        }
        case 'cancel': {
          if (CLOSED.has(task.status))
            throw new MissionError('state', `The task is already ${task.status}`)
          this.writeTask(id, { status: 'cancelled' })
          out.push(statusEvent(task, task.status, 'cancelled', USER))
          break
        }
      }
      this.refreshReadiness(out, task.missionId, USER)
      this.completeIfFinished(out, task.missionId)
      return this.mustTask(id)
    })
  }

  /** Delete a task that was never started and that nothing depends on. */
  removeTask(id: string, actor: Actor = USER): void {
    const task = this.mustTask(id)
    const siblings = this.loadTasks(task.missionId)
    if (task.attempts > 0 || !(NOT_STARTED.has(task.status) || task.status === 'cancelled')) {
      throw new MissionError(
        'state',
        'Only a task that never started can be removed; cancel it instead',
      )
    }
    if (dependentsOf(id, siblings).length > 0) {
      throw new MissionError('state', 'Other tasks depend on this one')
    }
    this.transact((out) => {
      this.deps.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
      out.push({
        type: 'task.updated',
        source: actor.source,
        ...(actor.employeeId && { actorId: actor.employeeId }),
        missionId: task.missionId,
        taskId: id,
        payload: { taskId: id, missionId: task.missionId, fields: ['removed'] },
      })
    })
  }

  // ---------- dispatch (the dispatcher) ----------

  /** Tasks that could be handed out now, in the order they should be. */
  dispatchCandidates(): Task[] {
    const rows = this.deps.db
      .prepare(
        `SELECT t.id FROM tasks t JOIN missions m ON m.id = t.mission_id
         WHERE m.status = 'running' AND m.archived_at IS NULL
           AND t.status IN ('ready', 'changes_requested') AND t.assignee_id IS NOT NULL
         ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
                  m.created_at, t.position`,
      )
      .all() as Array<{ id: string }>
    return rows.flatMap((row) => {
      const task = this.getTask(row.id)
      return task ? [task] : []
    })
  }

  hasActiveTask(employeeId: string): boolean {
    return (
      this.deps.db
        .prepare("SELECT 1 FROM tasks WHERE assignee_id = ? AND status = 'in_progress' LIMIT 1")
        .get(employeeId) !== undefined
    )
  }

  /**
   * Claim a task for its assignee: `in_progress`, one more attempt. Atomic, so two
   * callers can never both claim it. Throws if it is not claimable.
   */
  markDispatched(taskId: string): Task {
    return this.transact((out) => {
      const before = this.mustTask(taskId)
      const info = this.deps.db
        .prepare(
          `UPDATE tasks SET status = 'in_progress', attempts = attempts + 1,
                            started_at = COALESCE(started_at, @ts), blocked_reason = NULL, updated_at = @ts
           WHERE id = @id AND status IN ('ready', 'changes_requested') AND assignee_id IS NOT NULL
             AND mission_id IN (SELECT id FROM missions WHERE status = 'running')`,
        )
        .run({ id: taskId, ts: this.stamp() })
      if (info.changes !== 1)
        throw new MissionError('state', 'The task cannot be handed out right now')
      out.push(statusEvent(before, before.status, 'in_progress', SYSTEM, 'handed to its assignee'))
      return this.mustTask(taskId)
    })
  }

  /** Delivery failed after the claim: put the task back the way it was. */
  revertDispatch(taskId: string, reason: string): void {
    this.transact((out) => {
      const task = this.mustTask(taskId)
      if (task.status !== 'in_progress') return
      const back: TaskStatus = task.reviewNote ? 'changes_requested' : 'ready'
      this.deps.db
        .prepare(
          'UPDATE tasks SET status = @back, attempts = MAX(attempts - 1, 0), updated_at = @ts WHERE id = @id',
        )
        .run({ id: taskId, back, ts: this.stamp() })
      out.push(statusEvent(task, 'in_progress', back, SYSTEM, reason))
    })
  }

  /** A `task.dispatched` event: the briefing reached the agent's terminal. */
  announceDispatched(task: Task): void {
    if (!task.assigneeId) return
    this.deps.events.publish({
      type: 'task.dispatched',
      source: 'system',
      missionId: task.missionId,
      taskId: task.id,
      actorId: task.assigneeId,
      payload: {
        taskId: task.id,
        missionId: task.missionId,
        employeeId: task.assigneeId,
        attempt: task.attempts,
      },
    })
  }

  /** The text to give the agent for this task. */
  briefing(taskId: string): string {
    const task = this.mustTask(taskId)
    const mission = this.mustMission(task.missionId)
    const siblings = this.loadTasks(task.missionId)
    return buildBriefing({
      missionTitle: mission.title,
      taskId: task.id,
      title: task.title,
      description: task.description,
      attempt: task.attempts,
      reviewNote: task.reviewNote,
      dependencies: task.dependsOn.flatMap((dep) => {
        const done = siblings.find(
          (candidate) => candidate.id === dep && candidate.status === 'done',
        )
        return done ? [{ title: done.title, summary: done.summary }] : []
      }),
    })
  }

  /** The agent's process ended: whatever it was working on cannot finish. */
  blockAgentTasks(employeeId: string, reason: string): void {
    const active = this.deps.db
      .prepare("SELECT id FROM tasks WHERE assignee_id = ? AND status = 'in_progress'")
      .all(employeeId) as Array<{ id: string }>
    if (active.length === 0) return
    this.transact((out) => {
      for (const { id } of active) {
        const task = this.mustTask(id)
        this.writeTask(id, { status: 'blocked', blocked_reason: reason })
        out.push(statusEvent(task, 'in_progress', 'blocked', SYSTEM, reason))
      }
    })
  }

  /**
   * At startup no agent is running, so any task still `in_progress` was interrupted by a
   * restart or crash. Block it (rather than leave it pretending) so a person decides.
   */
  blockAllInProgress(reason: string): number {
    const active = this.deps.db
      .prepare("SELECT id FROM tasks WHERE status = 'in_progress'")
      .all() as Array<{ id: string }>
    if (active.length === 0) return 0
    this.transact((out) => {
      for (const { id } of active) {
        const task = this.mustTask(id)
        this.writeTask(id, { status: 'blocked', blocked_reason: reason })
        out.push(statusEvent(task, 'in_progress', 'blocked', SYSTEM, reason))
      }
    })
    return active.length
  }

  // ---------- agent tools ----------

  /** The task this employee was handed and has not yet submitted, if any. */
  currentTaskFor(employeeId: string): Task | undefined {
    const row = this.deps.db
      .prepare(
        "SELECT * FROM tasks WHERE assignee_id = ? AND status = 'in_progress' ORDER BY started_at LIMIT 1",
      )
      .get(employeeId) as TaskRow | undefined
    return row && this.hydrate([row])[0]
  }

  /**
   * An agent says it is finished. That makes the task `submitted` — a claim awaiting a
   * person — never `done`. An agent can only submit the task it was handed.
   */
  agentSubmit(
    employeeId: string,
    args: { taskId?: string | undefined; summary: string },
    actor: Actor,
  ): Task {
    return this.transact((out) => {
      const task = this.taskOfAgent(employeeId, args.taskId)
      const summary = cleanAgentText(args.summary)
      if (summary.length === 0)
        throw new MissionError('invalid', 'Give a short summary of what you did')
      this.writeTask(task.id, { status: 'submitted', summary, submitted_at: this.stamp() })
      out.push(
        statusEvent(
          task,
          'in_progress',
          'submitted',
          { ...actor, employeeId },
          'submitted by the agent',
        ),
      )
      return this.mustTask(task.id)
    })
  }

  agentBlocked(
    employeeId: string,
    args: { taskId?: string | undefined; reason: string },
    actor: Actor,
  ): Task {
    return this.transact((out) => {
      const task = this.taskOfAgent(employeeId, args.taskId)
      const reason = cleanAgentText(args.reason)
      if (reason.length === 0) throw new MissionError('invalid', 'Say what is blocking you')
      this.writeTask(task.id, { status: 'blocked', blocked_reason: reason })
      out.push(statusEvent(task, 'in_progress', 'blocked', { ...actor, employeeId }, reason))
      return this.mustTask(task.id)
    })
  }

  // ---------- internals ----------

  /** The in-progress task this agent may act on; refuses anything else. */
  private taskOfAgent(employeeId: string, taskId: string | undefined): Task {
    const current = this.currentTaskFor(employeeId)
    if (taskId !== undefined) {
      const named = this.getTask(taskId)
      if (!named) throw new MissionError('not-found', 'There is no such task')
      if (named.assigneeId !== employeeId)
        throw new MissionError('forbidden', 'That task is not yours')
      if (named.status !== 'in_progress') {
        throw new MissionError(
          'state',
          `That task is ${named.status.replace('_', ' ')}, not in progress`,
        )
      }
      return named
    }
    if (!current) throw new MissionError('state', 'You have no task in progress')
    return current
  }

  private requireStatus(task: Task, allowed: readonly TaskStatus[], message: string): void {
    if (!allowed.includes(task.status)) throw new MissionError('state', message)
  }

  /** Move waiting tasks to ready (and back) as their dependencies change. */
  private refreshReadiness(out: EventInput[], missionId: string, actor: Actor): void {
    const tasks = this.loadTasks(missionId)
    const status = new Map(tasks.map((task) => [task.id, task.status]))
    for (const task of tasks) {
      if (!NOT_STARTED.has(task.status)) continue
      const wanted = waitingOrReady(task, (dep) => status.get(dep))
      if (wanted === task.status) continue
      this.writeTask(task.id, { status: wanted })
      status.set(task.id, wanted)
      out.push(statusEvent(task, task.status, wanted, actor, 'dependencies changed'))
    }
  }

  /** A mission whose tasks are all closed (and at least one done) is finished. */
  private completeIfFinished(out: EventInput[], missionId: string): void {
    const mission = this.mustMission(missionId)
    if (mission.status !== 'running' && mission.status !== 'paused') return
    const tasks = this.loadTasks(missionId)
    if (tasks.length === 0 || !tasks.every((task) => CLOSED.has(task.status))) return
    if (!tasks.some((task) => task.status === 'done')) return
    this.setMissionStatus(
      out,
      missionId,
      mission.status,
      'completed',
      SYSTEM,
      'every task is closed',
    )
  }

  private setMissionStatus(
    out: EventInput[],
    id: string,
    from: MissionStatus,
    to: MissionStatus,
    actor: Actor,
    reason: string,
  ): void {
    this.deps.db
      .prepare('UPDATE missions SET status = @to, updated_at = @ts WHERE id = @id')
      .run({ id, to, ts: this.stamp() })
    out.push({
      type: 'mission.status.changed',
      source: actor.source,
      missionId: id,
      payload: { missionId: id, from, to, reason },
    })
  }

  private checkAssignee(assigneeId: string | null): void {
    if (assigneeId !== null && !this.deps.employeeExists(assigneeId)) {
      throw new MissionError('unknown-employee', 'That employee does not exist')
    }
  }

  private checkDependencies(
    dependsOn: readonly string[],
    siblings: readonly Task[],
    selfId?: string,
  ): void {
    const known = new Set(siblings.map((task) => task.id))
    for (const dep of dependsOn) {
      if (!known.has(dep))
        throw new MissionError('invalid', 'A dependency is not part of this mission')
    }
    if (new Set(dependsOn).size !== dependsOn.length) {
      throw new MissionError('invalid', 'A dependency is listed twice')
    }
    if (selfId !== undefined) {
      if (dependsOn.includes(selfId))
        throw new MissionError('cycle', 'A task cannot depend on itself')
      if (wouldCreateCycle(selfId, dependsOn, edgesOf(siblings))) {
        throw new MissionError(
          'cycle',
          'That would make the tasks depend on each other in a circle',
        )
      }
    }
  }

  private writeDependencies(taskId: string, dependsOn: readonly string[]): void {
    this.deps.db.prepare('DELETE FROM task_dependencies WHERE task_id = ?').run(taskId)
    const insert = this.deps.db.prepare(
      'INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)',
    )
    for (const dep of dependsOn) insert.run(taskId, dep)
  }

  /** Update whitelisted columns of a task (internal call sites only). */
  private writeTask(id: string, columns: Record<string, string | number | null>): void {
    const names = Object.keys(columns)
    const sets = names.map((name) => `${name} = @${name}`).join(', ')
    this.deps.db
      .prepare(`UPDATE tasks SET ${sets}, updated_at = @ts WHERE id = @id`)
      .run({ ...columns, id, ts: this.stamp() })
  }

  private loadTasks(missionId: string): Task[] {
    const rows = this.deps.db
      .prepare('SELECT * FROM tasks WHERE mission_id = ? ORDER BY position')
      .all(missionId) as TaskRow[]
    return this.hydrate(rows)
  }

  private hydrate(rows: readonly TaskRow[]): Task[] {
    if (rows.length === 0) return []
    const ids = rows.map((row) => row.id)
    const deps = this.deps.db
      .prepare(
        `SELECT task_id, depends_on_id FROM task_dependencies WHERE task_id IN (${ids.map(() => '?').join(',')})`,
      )
      .all(...ids) as Array<{ task_id: string; depends_on_id: string }>
    const byTask = new Map<string, string[]>()
    for (const dep of deps)
      byTask.set(dep.task_id, [...(byTask.get(dep.task_id) ?? []), dep.depends_on_id])
    return rows.map((row) => toTask(row, byTask.get(row.id) ?? []))
  }

  private mustMission(id: string): Mission {
    const mission = this.getMission(id)
    if (!mission) throw new MissionError('not-found', 'There is no such mission')
    return mission
  }

  private mustTask(id: string): Task {
    const task = this.getTask(id)
    if (!task) throw new MissionError('not-found', 'There is no such task')
    return task
  }

  private stamp(): string {
    return this.now().toISOString()
  }

  /** One transaction; events are published only after it commits. */
  private transact<T>(work: (out: EventInput[]) => T): T {
    const out: EventInput[] = []
    const result = this.deps.db.transaction(() => work(out))()
    for (const event of out) this.deps.events.publish(event)
    return result
  }
}

const MISSION_TRANSITIONS: Record<MissionAction, Partial<Record<MissionStatus, MissionStatus>>> = {
  run: { draft: 'running', paused: 'running' },
  pause: { running: 'paused' },
  cancel: { draft: 'cancelled', running: 'cancelled', paused: 'cancelled' },
}
const PAST_TENSE: Record<MissionAction, string> = {
  run: 'started',
  pause: 'paused',
  cancel: 'cancelled',
}

function statusEvent(
  task: Pick<Task, 'id' | 'missionId'>,
  from: TaskStatus,
  to: TaskStatus,
  actor: Actor,
  reason?: string,
): EventInput {
  return {
    type: 'task.status.changed',
    source: actor.source,
    missionId: task.missionId,
    taskId: task.id,
    ...(actor.employeeId && { actorId: actor.employeeId }),
    payload: { taskId: task.id, missionId: task.missionId, from, to, ...(reason && { reason }) },
  }
}

function assignedEvent(
  taskId: string,
  missionId: string,
  employeeId: string | null,
  actor: Actor,
): EventInput {
  return {
    type: 'task.assigned',
    source: actor.source,
    ...(actor.employeeId && { actorId: actor.employeeId }),
    missionId,
    taskId,
    payload: { taskId, missionId, employeeId },
  }
}

/** Agent-written text: single-spaced-ish, no control characters, bounded. */
function cleanAgentText(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.charCodeAt(0)
    if (code === 0x0a || code === 0x09) out += char
    else if (code < 0x20 || code === 0x7f) out += ' '
    else out += char
  }
  return out.trim().slice(0, MAX_AGENT_TEXT)
}

function firstIssue(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  const issue = error.issues[0]
  if (!issue) return 'Invalid input'
  const field = issue.path.map(String).join('.')
  return field ? `${field}: ${issue.message}` : issue.message
}

function toMission(row: MissionRow): Mission {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as MissionStatus,
    priority: row.priority as Priority,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toTask(row: TaskRow, dependsOn: string[]): Task {
  return {
    id: row.id,
    missionId: row.mission_id,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    assigneeId: row.assignee_id,
    priority: row.priority as Priority,
    dependsOn,
    attempts: row.attempts,
    summary: row.summary,
    blockedReason: row.blocked_reason,
    reviewNote: row.review_note,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    submittedAt: row.submitted_at,
    completedAt: row.completed_at,
  }
}
