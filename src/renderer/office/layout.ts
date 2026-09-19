/** Room geometry and where each employee's desk goes. */
export const ROOM_WIDTH = 8
export const ROOM_DEPTH = 7
export const WALL_HEIGHT = 2.8

export interface DeskSlot {
  /** Low corner of the desk's footprint, in grid units. */
  x: number
  y: number
}

/** Up to four desks in a 2x2 arrangement; more employees than that are not shown yet. */
export const DESK_SLOTS: readonly DeskSlot[] = [
  { x: 1.2, y: 1.0 },
  { x: 5.4, y: 1.0 },
  { x: 1.2, y: 4.4 },
  { x: 5.4, y: 4.4 },
]

export const MAX_VISIBLE_EMPLOYEES = DESK_SLOTS.length

/** Employees that get a desk, and how many are left over. */
export function assignDesks<T>(employees: readonly T[]): {
  seated: Array<{ employee: T; slot: DeskSlot }>
  overflow: number
} {
  const seated = employees
    .slice(0, MAX_VISIBLE_EMPLOYEES)
    .map((employee, index) => ({ employee, slot: DESK_SLOTS[index] as DeskSlot }))
  return { seated, overflow: Math.max(0, employees.length - MAX_VISIBLE_EMPLOYEES) }
}
