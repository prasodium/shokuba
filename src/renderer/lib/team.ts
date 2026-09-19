import type { Employee } from '@shared/employees'

/** One line of the roster: an employee, and the manager they sit under (if any). */
export interface TeamRow {
  employee: Employee
  manager: Employee | null
}

/**
 * The roster in team order: each manager followed by the people who report to them, then
 * everyone who is on no team. The order within each group is the order they were hired.
 */
export function orderTeam(employees: readonly Employee[]): TeamRow[] {
  const rows: TeamRow[] = []
  const placed = new Set<string>()
  for (const manager of employees.filter((employee) => employee.isManager)) {
    rows.push({ employee: manager, manager: null })
    placed.add(manager.id)
    for (const employee of employees) {
      if (employee.reportsTo !== manager.id || placed.has(employee.id)) continue
      rows.push({ employee, manager })
      placed.add(employee.id)
    }
  }
  for (const employee of employees) {
    if (!placed.has(employee.id)) rows.push({ employee, manager: null })
  }
  return rows
}
