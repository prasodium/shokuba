import type { AgentView } from '@shared/agents/view'
import type { Mission, Task } from '@shared/missions'

/**
 * Why a task that is ready has not been handed to its agent yet — or that it is about to be.
 * Returns null for tasks that are not waiting to be handed out. The dispatcher's rules are
 * strict (it pastes into a terminal), so people need to be able to see what it is waiting for.
 */
export function dispatchHint(
  task: Pick<Task, 'status' | 'assigneeId'>,
  mission: Pick<Mission, 'status'>,
  assigneeName: string | null,
  view: AgentView | undefined,
): string | null {
  if (task.status !== 'ready' && task.status !== 'changes_requested') return null
  if (mission.status === 'draft') return 'Waiting for you to run the mission.'
  if (mission.status === 'paused') return 'The mission is paused, so nothing is sent.'
  if (mission.status !== 'running') return null
  if (task.assigneeId === null) return 'Assign someone to this task so it can be sent.'

  const name = assigneeName ?? 'The assignee'
  if (!view || view.pid === null) return `${name} is not running. Start them and it will be sent.`
  if (view.state === 'starting') return `${name} is still starting up.`
  if (view.state === 'waiting')
    return `${name} is waiting for you (a permission prompt). Answer it first.`
  if (view.state !== 'idle')
    return `${name} is busy (${view.state}). It will be sent when they finish.`
  if (view.stateSource !== 'reported' && view.stateSource !== 'simulated') {
    return `${name} looks idle, but that is only a guess. It will be sent after their next turn.`
  }
  return `Sending to ${name}…`
}
