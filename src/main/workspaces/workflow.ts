import { CONFLICT_NOTE_PREFIX } from '@shared/git'
import type { Task, TaskAction } from '@shared/missions'
import type { MissionService } from '../missions/service'
import type { AcceptMerge } from './service'

/** The part of the workspace service the workflow needs. */
export interface Merger {
  mergeForAccept(task: Task): Promise<AcceptMerge>
}

const MAX_FILES_NAMED = 10

/**
 * What a person's decision on a task does to the work itself. Accepting a task merges its
 * branch into the mission branch first, so tasks that depend on it start from it; if that
 * conflicts with work accepted earlier, the task is not accepted but sent back to its agent
 * with the files named and the steps to fix it. Everything else is the plain task action.
 */
export class TaskWorkflow {
  constructor(
    private readonly missions: MissionService,
    private readonly workspaces: Merger,
  ) {}

  async action(taskId: string, action: TaskAction): Promise<Task> {
    if (action.action !== 'accept') return this.missions.taskAction(taskId, action)

    const task = this.missions.getTask(taskId)
    // Anything but a submitted task is refused by the task rules; do not touch Git for it.
    if (!task || task.status !== 'submitted') return this.missions.taskAction(taskId, action)

    const merge = await this.workspaces.mergeForAccept(task)
    if (merge.kind === 'conflict') {
      return this.missions.taskAction(taskId, {
        action: 'request-changes',
        note: conflictNote(merge.files, merge.missionBranch),
      })
    }
    return this.missions.taskAction(taskId, action)
  }
}

/** What the agent is told when its work conflicts with work accepted before it. */
export function conflictNote(files: readonly string[], missionBranch: string): string {
  const named = files.slice(0, MAX_FILES_NAMED).map(printable)
  const more = files.length > MAX_FILES_NAMED ? ` and ${files.length - MAX_FILES_NAMED} more` : ''
  return (
    `${CONFLICT_NOTE_PREFIX} it conflicts with work accepted before yours, in ${named.join(', ') || 'some files'}${more}. ` +
    `In your working folder run "git merge ${missionBranch}", resolve the conflicts in those files, ` +
    'commit the result, and submit again. Keep what the other work changed unless it is wrong.'
  )
}

/** A file name that is safe to put in a note: control characters would break the terminal it is pasted into. */
function printable(name: string): string {
  return [...name]
    .map((char) => (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f ? '?' : char))
    .join('')
}
