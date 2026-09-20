import type { Department } from '@shared/departments'
import type { Employee } from '@shared/employees'
import { orderTeam, type TeamRow } from './team'

/** One section of the roster: a department (or none) and its people in team order. */
export interface RosterSection {
  /** The department, or null for people who are in none. */
  department: Department | null
  rows: TeamRow[]
}

/**
 * The roster grouped by department, in the order the departments were made, then people in none.
 * Inside each section people are in team order. A department nobody is in is left out; someone whose
 * department is not known (say, it was removed a moment ago) is treated as in none. With no
 * departments there is one section for everyone, so the roster looks as it always did.
 */
export function groupByDepartment(
  employees: readonly Employee[],
  departments: readonly Department[],
): RosterSection[] {
  const known = new Map(departments.map((d) => [d.id, d]))
  const sections: RosterSection[] = []
  for (const department of departments) {
    const members = employees.filter((e) => e.departmentId === department.id)
    if (members.length > 0) sections.push({ department, rows: orderTeam(members) })
  }
  const rest = employees.filter((e) => e.departmentId === null || !known.has(e.departmentId))
  if (rest.length > 0) sections.push({ department: null, rows: orderTeam(rest) })
  return sections
}
