import type { Task, TaskStatus } from '../missions'

/** Dependency edges: task id -> the ids it depends on. */
export type Edges = ReadonlyMap<string, readonly string[]>

export function edgesOf(tasks: readonly Pick<Task, 'id' | 'dependsOn'>[]): Map<string, string[]> {
  return new Map(tasks.map((task) => [task.id, [...task.dependsOn]]))
}

/**
 * Would giving `taskId` these dependencies create a cycle? True when `taskId` is
 * reachable from any of them by following dependencies (or a task depends on itself).
 */
export function wouldCreateCycle(
  taskId: string,
  dependsOn: readonly string[],
  edges: Edges,
): boolean {
  const seen = new Set<string>()
  const stack = [...dependsOn]
  while (stack.length > 0) {
    const current = stack.pop() as string
    if (current === taskId) return true
    if (seen.has(current)) continue
    seen.add(current)
    stack.push(...(edges.get(current) ?? []))
  }
  return false
}

/** Ids of tasks that depend (directly) on `taskId`. */
export function dependentsOf(
  taskId: string,
  tasks: readonly Pick<Task, 'id' | 'dependsOn'>[],
): string[] {
  return tasks.filter((task) => task.dependsOn.includes(taskId)).map((task) => task.id)
}

/**
 * Whether a task that has not started is waiting or ready, from its dependencies.
 * Only `done` satisfies a dependency: a cancelled task leaves its dependents waiting,
 * so that someone decides what that means rather than the system guessing.
 */
export function waitingOrReady(
  task: Pick<Task, 'dependsOn'>,
  statusOf: (id: string) => TaskStatus | undefined,
): 'pending' | 'ready' {
  return task.dependsOn.every((id) => statusOf(id) === 'done') ? 'ready' : 'pending'
}

/**
 * Column for each task when drawing the graph left to right: tasks with no dependencies
 * are in column 0, every other task one column after its furthest dependency.
 * Tolerates unknown ids and (defensively) cycles, which it never loops on.
 */
export function layerize(tasks: readonly Pick<Task, 'id' | 'dependsOn'>[]): Map<string, number> {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const layer = new Map<string, number>()
  const visiting = new Set<string>()

  const visit = (id: string): number => {
    const known = layer.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 0
    visiting.add(id)
    const task = byId.get(id)
    const deps = (task?.dependsOn ?? []).filter((dep) => byId.has(dep))
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(visit))
    visiting.delete(id)
    layer.set(id, value)
    return value
  }

  for (const task of tasks) visit(task.id)
  return layer
}
