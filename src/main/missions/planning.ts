import type { Mission, Task } from '@shared/missions'
import { MissionError, type MissionService } from './service'

/** The most drafts a manager may have open at once, and the most tasks in one of them. */
export const MAX_OPEN_DRAFTS = 3
export const MAX_TASKS_PER_DRAFT = 25

/** One employee, as planning sees them. */
export interface PlanMember {
  id: string
  name: string
  role: string
  isManager?: boolean
  reportsTo?: string | null
}

export interface PlanTeam {
  list(): PlanMember[]
  isRunning(employeeId: string): boolean
}

/**
 * What a manager's agent may do about work: draft missions and tasks for its own team, and
 * look at how the team is doing. It never runs, pauses or cancels a mission, never accepts or
 * changes anything a person or another manager created, and never assigns work outside its
 * team, so a plan only ever becomes real when a person reads it and presses Run.
 *
 * These are the rules; the tools in `mcp/agent-tools.ts` only translate to and from text.
 */
export class ManagerPlanning {
  constructor(
    private readonly missions: MissionService,
    private readonly team: PlanTeam,
  ) {}

  isManager(employeeId: string): boolean {
    return this.team.list().find((member) => member.id === employeeId)?.isManager === true
  }

  draftMission(
    managerId: string,
    input: {
      title: string
      description?: string | undefined
      priority?: 'low' | 'normal' | 'high' | undefined
    },
    source: 'reported' | 'simulated',
  ): Mission {
    this.requireManager(managerId)
    const open = this.openDrafts(managerId)
    if (open.length >= MAX_OPEN_DRAFTS) {
      throw new MissionError(
        'forbidden',
        `You already have ${open.length} drafts waiting for the person (${open.map((m) => `"${m.title}"`).join(', ')}). ` +
          'Wait for them to run or discard one before drafting another.',
      )
    }
    return this.missions.createMission(
      {
        title: input.title,
        ...(input.description !== undefined && { description: input.description }),
        ...(input.priority !== undefined && { priority: input.priority }),
      },
      { source, employeeId: managerId },
    )
  }

  addTask(
    managerId: string,
    input: {
      missionId: string
      title: string
      description?: string | undefined
      assignee?: string | undefined
      dependsOn?: string[] | undefined
      priority?: 'low' | 'normal' | 'high' | undefined
    },
    source: 'reported' | 'simulated',
  ): { task: Task; assigneeName: string | null; waitsFor: string[] } {
    const mission = this.ownDraft(managerId, input.missionId)
    const siblings = this.tasksOf(mission.id)
    if (siblings.length >= MAX_TASKS_PER_DRAFT) {
      throw new MissionError(
        'forbidden',
        `A draft holds at most ${MAX_TASKS_PER_DRAFT} tasks. Group the work into fewer, larger tasks, or draft a second mission once the person has run this one.`,
      )
    }
    const assignee = input.assignee ? this.resolveAssignee(managerId, input.assignee) : null
    const dependsOn = (input.dependsOn ?? []).map((ref) => this.resolveTask(siblings, ref))
    const task = this.missions.createTask(
      {
        missionId: mission.id,
        title: input.title,
        ...(input.description !== undefined && { description: input.description }),
        assigneeId: assignee?.id ?? null,
        ...(input.priority !== undefined && { priority: input.priority }),
        dependsOn: dependsOn.map((dep) => dep.id),
      },
      { source, employeeId: managerId },
    )
    return {
      task,
      assigneeName: assignee?.name ?? null,
      waitsFor: dependsOn.map((dep) => dep.title),
    }
  }

  removeTask(managerId: string, taskId: string, source: 'reported' | 'simulated'): Task {
    const task = this.missions.getTask(taskId)
    if (!task) throw new MissionError('not-found', 'There is no such task')
    this.ownDraft(managerId, task.missionId)
    this.missions.removeTask(taskId, { source, employeeId: managerId })
    return task
  }

  /** A draft this manager wrote, with its tasks: for reviewing the plan before telling the person. */
  describeDraft(managerId: string, missionId: string | undefined): string {
    this.requireManager(managerId)
    if (missionId === undefined) {
      const open = this.openDrafts(managerId)
      if (open.length === 0) return 'You have no drafts waiting.'
      return [
        'Your drafts:',
        ...open.map((m) => `- "${m.title}" — id ${m.id} — ${this.tasksOf(m.id).length} tasks`),
      ].join('\n')
    }
    const mission = this.mission(managerId, missionId)
    const tasks = this.tasksOf(mission.id)
    const names = new Map(this.team.list().map((member) => [member.id, member.name]))
    const title = new Map(tasks.map((task) => [task.id, task.title]))
    return [
      `"${mission.title}" — id ${mission.id} — ${mission.status}${mission.status === 'draft' ? ' (waiting for the person to run it)' : ''}`,
      ...(tasks.length === 0
        ? ['(no tasks yet)']
        : tasks.map((task) => {
            const who = task.assigneeId ? (names.get(task.assigneeId) ?? 'someone') : 'unassigned'
            const after = task.dependsOn.map((dep) => title.get(dep) ?? dep)
            return `- "${task.title}" — id ${task.id} — ${who}${after.length > 0 ? ` — after: ${after.join(', ')}` : ''} — ${task.status}`
          })),
    ].join('\n')
  }

  /** Who is on this manager's team, and what each is doing. Read-only. */
  teamStatus(managerId: string): string {
    this.requireManager(managerId)
    const reports = this.team.list().filter((member) => member.reportsTo === managerId)
    if (reports.length === 0) return 'Nobody reports to you yet.'
    return [
      'Your team:',
      ...reports.map((member) => {
        const running = this.team.isRunning(member.id) ? 'running' : 'not running'
        const task = this.missions.currentTaskFor(member.id)
        return `- ${member.name} (${member.role}) — ${running} — ${task ? `working on "${task.title}"` : 'no task in progress'}`
      }),
    ].join('\n')
  }

  // ---------- rules ----------

  private requireManager(employeeId: string): void {
    if (!this.isManager(employeeId)) {
      throw new MissionError('forbidden', 'Only a manager can plan work for a team.')
    }
  }

  private openDrafts(managerId: string): Mission[] {
    return this.missions
      .listMissions()
      .map((detail) => detail.mission)
      .filter((mission) => mission.createdBy === managerId && mission.status === 'draft')
  }

  /** A mission this manager wrote, in any state. */
  private mission(managerId: string, missionId: string): Mission {
    const mission = this.missions.getMission(missionId)
    if (!mission) throw new MissionError('not-found', 'There is no such mission.')
    if (mission.createdBy !== managerId) {
      throw new MissionError('forbidden', 'You can only work on missions you drafted yourself.')
    }
    return mission
  }

  /** A mission this manager wrote that has not been run: the only thing they may change. */
  private ownDraft(managerId: string, missionId: string): Mission {
    this.requireManager(managerId)
    const mission = this.mission(managerId, missionId)
    if (mission.status !== 'draft') {
      throw new MissionError(
        'forbidden',
        `"${mission.title}" is ${mission.status}, so it is out of your hands: only a draft can be changed. Draft a new mission if more work is needed.`,
      )
    }
    return mission
  }

  private tasksOf(missionId: string): Task[] {
    return (
      this.missions.listMissions().find((detail) => detail.mission.id === missionId)?.tasks ?? []
    )
  }

  /** The manager, or someone who reports to them: never anyone else. */
  private resolveAssignee(managerId: string, wanted: string): PlanMember {
    const eligible = this.team
      .list()
      .filter((member) => member.id === managerId || member.reportsTo === managerId)
    const needle = wanted.trim().toLowerCase()
    const matches = eligible.filter(
      (member) => member.id === wanted.trim() || member.name.toLowerCase() === needle,
    )
    const [match] = matches
    if (!match || matches.length > 1) {
      const who = eligible.map((member) => member.name).join(', ')
      throw new MissionError(
        matches.length > 1 ? 'invalid' : 'forbidden',
        matches.length > 1
          ? `More than one person is called "${wanted}". Use their id from list_teammates.`
          : `"${wanted}" is not on your team. You can assign work to: ${who}.`,
      )
    }
    return match
  }

  /** A task in this draft, by id or by exact title. */
  private resolveTask(siblings: readonly Task[], ref: string): Task {
    const wanted = ref.trim()
    const byId = siblings.find((task) => task.id === wanted)
    if (byId) return byId
    const byTitle = siblings.filter((task) => task.title.toLowerCase() === wanted.toLowerCase())
    if (byTitle.length === 1 && byTitle[0]) return byTitle[0]
    throw new MissionError(
      'invalid',
      byTitle.length > 1
        ? `More than one task is called "${ref}". Use its id.`
        : `"${ref}" is not a task in this draft. Add it first, or use the id or exact title of a task already added.`,
    )
  }
}
