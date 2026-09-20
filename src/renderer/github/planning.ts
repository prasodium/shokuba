import type { Employee } from '@shared/employees'
import type { Mission } from '@shared/missions'

/** What to offer a person about getting an imported draft planned, given where it stands. */
export type PlanningView =
  /** Only a draft can be handed to someone to plan. */
  | { kind: 'hidden' }
  /** It has been handed over: who has it. */
  | { kind: 'planning'; managerName: string }
  /** It can be: to which managers. */
  | { kind: 'ask'; managers: Array<{ id: string; name: string }> }
  /** There is no one to hand it to. */
  | { kind: 'no-manager' }

export function planningView(
  mission: Pick<Mission, 'status' | 'plannerId'>,
  employees: ReadonlyArray<Pick<Employee, 'id' | 'name' | 'isManager'>>,
): PlanningView {
  if (mission.status !== 'draft') return { kind: 'hidden' }
  if (mission.plannerId !== null) {
    const planner = employees.find((employee) => employee.id === mission.plannerId)
    return { kind: 'planning', managerName: planner?.name ?? 'a manager' }
  }
  const managers = employees
    .filter((employee) => employee.isManager)
    .map(({ id, name }) => ({ id, name }))
  return managers.length > 0 ? { kind: 'ask', managers } : { kind: 'no-manager' }
}
