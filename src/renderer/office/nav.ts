import {
  STATION_WIDTH,
  seatPoint,
  stationRect,
  type DeskSlot,
  type OfficeMap,
  type Point2,
  type Rect,
} from './map'

/**
 * Where people can walk, and how to get from one place to another. Pure, so it is tested rather
 * than eyeballed.
 *
 * The floor is cut into half-tile cells. A cell is free if a walker standing at its centre, with
 * some width, would be on the floor and clear of every desk, wall, plant and piece of furniture, so
 * a path that goes through free cells never brushes anything. Paths are found with A* (eight ways,
 * never cutting a corner) and then straightened wherever the way is clear.
 */

/** Side of one cell, in tiles. */
export const CELL = 0.5
/** How far a walker's body reaches from its centre, in tiles. */
export const WALKER_RADIUS = 0.22

export interface NavGrid {
  cols: number
  rows: number
  /** 1 for a cell nobody can stand in, row by row. */
  blocked: Uint8Array
}

const inside = (p: Point2, r: Rect, grow = 0): boolean =>
  p.x > r.x - grow && p.x < r.x + r.w + grow && p.y > r.y - grow && p.y < r.y + r.d + grow

const cellCentre = (col: number, row: number): Point2 => ({
  x: (col + 0.5) * CELL,
  y: (row + 0.5) * CELL,
})

/** The cell a point is in (which may be off the grid). */
export function cellOf(p: Point2): { col: number; row: number } {
  return { col: Math.floor(p.x / CELL), row: Math.floor(p.y / CELL) }
}

/** Every solid thing on the floor of a plan. Walkers keep clear of all of them, empty desks too. */
export function solidsOf(map: OfficeMap): Rect[] {
  return [
    ...map.desks.map(stationRect),
    ...map.places.map((place) => place.footprint),
    ...map.props.map((prop) => prop.footprint),
    ...map.partitions,
  ]
}

export function buildNavGrid(map: OfficeMap, radius = WALKER_RADIUS): NavGrid {
  const cols = Math.ceil(map.width / CELL)
  const rows = Math.ceil(map.depth / CELL)
  const blocked = new Uint8Array(cols * rows)
  const solids = solidsOf(map)
  const floor = map.rooms.map((room) => room.rect)
  const onFloor = (p: Point2): boolean => floor.some((room) => inside(p, room, 1e-9))

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const c = cellCentre(col, row)
      // The whole body must be on the floor: rooms sit edge to edge, so a doorway is still floor.
      const body = [
        { x: c.x - radius, y: c.y - radius },
        { x: c.x + radius, y: c.y - radius },
        { x: c.x - radius, y: c.y + radius },
        { x: c.x + radius, y: c.y + radius },
      ]
      const clear = body.every(onFloor) && !solids.some((solid) => inside(c, solid, radius))
      if (!clear) blocked[row * cols + col] = 1
    }
  }
  return { cols, rows, blocked }
}

export function isFree(grid: NavGrid, col: number, row: number): boolean {
  return (
    col >= 0 &&
    row >= 0 &&
    col < grid.cols &&
    row < grid.rows &&
    !grid.blocked[row * grid.cols + col]
  )
}

/** Whether a point is somewhere a walker can stand. */
export function isFreePoint(grid: NavGrid, p: Point2): boolean {
  const { col, row } = cellOf(p)
  return isFree(grid, col, row)
}

/** The free cell nearest to `p`, searching a few cells out. Null if there is none close by. */
export function nearestFree(
  grid: NavGrid,
  p: Point2,
  reach = 4,
): { col: number; row: number } | null {
  const start = cellOf(p)
  if (isFree(grid, start.col, start.row)) return start
  let best: { col: number; row: number } | null = null
  let bestDistance = Infinity
  for (let dr = -reach; dr <= reach; dr += 1) {
    for (let dc = -reach; dc <= reach; dc += 1) {
      const col = start.col + dc
      const row = start.row + dr
      if (!isFree(grid, col, row)) continue
      const c = cellCentre(col, row)
      const distance = Math.hypot(c.x - p.x, c.y - p.y)
      if (distance < bestDistance) {
        bestDistance = distance
        best = { col, row }
      }
    }
  }
  return best
}

/** Whether a walker can go straight from `a` to `b`: every point along the way is free. */
export function lineClear(grid: NavGrid, a: Point2, b: Point2): boolean {
  const length = Math.hypot(b.x - a.x, b.y - a.y)
  const steps = Math.max(1, Math.ceil(length / 0.1))
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    if (!isFreePoint(grid, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) return false
  }
  return true
}

const SQRT2 = Math.SQRT2

/** A minimal binary heap of (cost, cell) pairs, so A* stays fast and the code stays short. */
class Heap {
  private readonly items: Array<{ cost: number; cell: number }> = []

  get size(): number {
    return this.items.length
  }

  push(cost: number, cell: number): void {
    const items = this.items
    items.push({ cost, cell })
    let i = items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if ((items[parent] as { cost: number }).cost <= (items[i] as { cost: number }).cost) break
      ;[items[parent], items[i]] = [items[i] as never, items[parent] as never]
      i = parent
    }
  }

  pop(): number {
    const items = this.items
    const top = items[0] as { cell: number }
    const last = items.pop() as { cost: number; cell: number }
    if (items.length > 0) {
      items[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let smallest = i
        if (
          l < items.length &&
          (items[l] as { cost: number }).cost < (items[smallest] as { cost: number }).cost
        )
          smallest = l
        if (
          r < items.length &&
          (items[r] as { cost: number }).cost < (items[smallest] as { cost: number }).cost
        )
          smallest = r
        if (smallest === i) break
        ;[items[smallest], items[i]] = [items[i] as never, items[smallest] as never]
        i = smallest
      }
    }
    return top.cell
  }
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, SQRT2],
  [1, -1, SQRT2],
  [-1, 1, SQRT2],
  [-1, -1, SQRT2],
]

/** The cells from `start` to `goal` by the shortest way, or null if there is none. */
function cellPath(
  grid: NavGrid,
  start: { col: number; row: number },
  goal: { col: number; row: number },
): Array<{ col: number; row: number }> | null {
  const { cols } = grid
  const index = (col: number, row: number): number => row * cols + col
  const from = index(start.col, start.row)
  const to = index(goal.col, goal.row)
  const cost = new Map<number, number>([[from, 0]])
  const came = new Map<number, number>()
  const open = new Heap()
  const closed = new Set<number>()
  const heuristic = (col: number, row: number): number => {
    const dx = Math.abs(col - goal.col)
    const dy = Math.abs(row - goal.row)
    return dx + dy + (SQRT2 - 2) * Math.min(dx, dy) // octile distance
  }
  open.push(heuristic(start.col, start.row), from)

  while (open.size > 0) {
    const current = open.pop()
    if (closed.has(current)) continue
    if (current === to) {
      const path: Array<{ col: number; row: number }> = []
      for (let at: number | undefined = current; at !== undefined; at = came.get(at)) {
        path.push({ col: at % cols, row: Math.floor(at / cols) })
      }
      return path.reverse()
    }
    closed.add(current)
    const col = current % cols
    const row = Math.floor(current / cols)
    const here = cost.get(current) as number
    for (const [dc, dr, step] of NEIGHBOURS) {
      const nc = col + dc
      const nr = row + dr
      if (!isFree(grid, nc, nr)) continue
      // Never cut a corner: a diagonal step needs both cells beside it free.
      if (dc !== 0 && dr !== 0 && (!isFree(grid, col + dc, row) || !isFree(grid, col, row + dr)))
        continue
      const next = index(nc, nr)
      const total = here + step
      if (total < (cost.get(next) ?? Infinity)) {
        cost.set(next, total)
        came.set(next, current)
        open.push(total + heuristic(nc, nr), next)
      }
    }
  }
  return null
}

/** Drop every point that a straight line can skip, so a path goes the way a person would. */
function straighten(grid: NavGrid, points: Point2[]): Point2[] {
  const out: Point2[] = []
  let anchor = 0
  while (anchor < points.length - 1) {
    let far = points.length - 1
    while (far > anchor + 1 && !lineClear(grid, points[anchor] as Point2, points[far] as Point2))
      far -= 1
    out.push(points[anchor] as Point2)
    anchor = far
  }
  out.push(points[points.length - 1] as Point2)
  return out
}

/**
 * The way from `from` to `to`, as points to walk through (the first is `from` and the last is
 * `to`). Either end may sit in a blocked cell, such as a seat: the path then starts or ends at the
 * nearest free cell, and the caller joins the rest. Null if there is no way.
 */
export function findPath(grid: NavGrid, from: Point2, to: Point2): Point2[] | null {
  const start = nearestFree(grid, from)
  const goal = nearestFree(grid, to)
  if (!start || !goal) return null
  const cells = cellPath(grid, start, goal)
  if (!cells) return null
  const middle = cells.map((cell) => cellCentre(cell.col, cell.row))
  const points: Point2[] = [from, ...middle, to]
  return straighten(grid, points)
}

/** Length of a path, in tiles. */
export function pathLength(points: readonly Point2[]): number {
  let total = 0
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(
      (points[i] as Point2).x - (points[i - 1] as Point2).x,
      (points[i] as Point2).y - (points[i - 1] as Point2).y,
    )
  }
  return total
}

/** How far past the workstation to look for a free cell to step out into, nearest first. */
const EXIT_REACH = [0.35, 0.6, 0.85, 1.1] as const

/**
 * Where a person steps out to when they stand up from their desk: level with the seat, past one
 * side of the workstation (or, failing that, behind it), on to the floor that leads to everywhere
 * else. It looks a little further out until it finds free floor, since a cell beside a desk can be
 * blocked by the desk. Null if no side is open, which the plan's tests rule out.
 */
export function seatExit(
  grid: NavGrid,
  slot: DeskSlot,
  mainFloor?: ReadonlySet<number>,
): Point2 | null {
  const seat = seatPoint(slot)
  const station = stationRect(slot)
  const sides: Array<(reach: number) => Point2> = [
    (reach) => ({ x: slot.x - reach, y: seat.y }),
    (reach) => ({ x: slot.x + STATION_WIDTH + reach, y: seat.y }),
    (reach) => ({ x: seat.x, y: slot.y - reach }),
  ]
  for (const side of sides) {
    for (const reach of EXIT_REACH) {
      const candidate = side(reach)
      if (!isFreePoint(grid, candidate)) continue
      if (mainFloor) {
        const { col, row } = cellOf(candidate)
        if (!mainFloor.has(row * grid.cols + col)) continue
      }
      // The way from the seat to the exit may cross the workstation's own floor, and nothing else.
      if (leavesClear(grid, seat, candidate, station)) return candidate
    }
  }
  return null
}

/** Whether the straight way from a seat to a point is clear once the seat's own workstation is ignored. */
function leavesClear(grid: NavGrid, from: Point2, to: Point2, station: Rect): boolean {
  const length = Math.hypot(to.x - from.x, to.y - from.y)
  const steps = Math.max(1, Math.ceil(length / 0.1))
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const p = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
    // Cells reaching within a walker's width (and a cell's rounding) of the workstation are blocked
    // because of it, so they do not count against the way out.
    if (!inside(p, station, WALKER_RADIUS + CELL / 2) && !isFreePoint(grid, p)) return false
  }
  return true
}

/** Every cell that can be reached from `from`: the floor that leads to everything else. */
export function reachableFrom(grid: NavGrid, from: Point2): Set<number> {
  const start = nearestFree(grid, from)
  const seen = new Set<number>()
  if (!start) return seen
  const queue = [start]
  seen.add(start.row * grid.cols + start.col)
  while (queue.length > 0) {
    const { col, row } = queue.pop() as { col: number; row: number }
    for (const [dc, dr] of NEIGHBOURS) {
      const nc = col + dc
      const nr = row + dr
      if (!isFree(grid, nc, nr)) continue
      if (dc !== 0 && dr !== 0 && (!isFree(grid, col + dc, row) || !isFree(grid, col, row + dr)))
        continue
      const key = nr * grid.cols + nc
      if (!seen.has(key)) {
        seen.add(key)
        queue.push({ col: nc, row: nr })
      }
    }
  }
  return seen
}
