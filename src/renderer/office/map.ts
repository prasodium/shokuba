/**
 * The office's floor plan, as data. Pure, so it can be tested without drawing anything: which
 * rooms exist, where the walls and doors are, where each desk goes, and where the shared places
 * are (the person's inbox, the QA bench, the reading room, the mission board).
 *
 * The plan grows with the team. There is always a commons room (the shared places) and a first
 * desk room; another desk room of four is added for every four employees, up to three. Rooms sit
 * in a 2x2 block; walls are only drawn on the two far sides and between rooms (low, so nothing is
 * hidden), and the near sides are open, as in a cutaway.
 *
 *        x ->
 *   y   +--------+--------+
 *   |   | desks  |commons |     desk room 1 and the commons room always exist
 *   v   +--------+--------+
 *       | desks  | desks  |     desk rooms 2 and 3 appear as the team grows
 *       +--------+--------+
 *
 * Units are floor tiles. x grows to the lower right on screen and y to the lower left; the far
 * corner is (0, 0).
 */

export const ROOM_WIDTH = 8
export const ROOM_DEPTH = 7
export const WALL_HEIGHT = 2.8
export const PARTITION_HEIGHT = 0.95
export const PARTITION_THICKNESS = 0.16
/** Length of one piece of a partition, so each piece can be depth-sorted on its own. */
export const WALL_PIECE = 0.25

export const DESKS_PER_ROOM = 4
export const MAX_DESK_ROOMS = 3
export const MAX_VISIBLE_EMPLOYEES = DESKS_PER_ROOM * MAX_DESK_ROOMS

/** Footprint of one workstation (chair, desk and monitor). */
export const STATION_WIDTH = 1.8
export const STATION_DEPTH = 1.7

export interface Point2 {
  x: number
  y: number
}

/** A rectangle on the floor: low corner, then size along x and y. */
export interface Rect {
  x: number
  y: number
  w: number
  d: number
}

export type RoomKind = 'desks' | 'commons'

export interface Room {
  id: string
  kind: RoomKind
  rect: Rect
}

/** Low corner of a workstation's footprint. */
export interface DeskSlot {
  x: number
  y: number
  roomId: string
}

/** A gap in a wall between two rooms. `axis` is the direction the wall runs along. */
export interface Door {
  axis: 'x' | 'y'
  /** The wall's fixed coordinate: y for a wall running along x, x for one along y. */
  at: number
  from: number
  to: number
  /** Where a person crosses, in the middle of the gap. */
  middle: Point2
}

export type PlaceKind = 'inbox' | 'qa' | 'reading' | 'board'

/** Something in the office that stands for something real. */
export interface Place {
  id: string
  kind: PlaceKind
  label: string
  footprint: Rect
  /** Where someone stands to use it (on the floor, clear of furniture). */
  stand: Point2
  /**
   * Every spot where someone can stand to use it at once (`stand` is the first). A place that only
   * one person can use at a time has one.
   */
  slots: Point2[]
  /** A reading place is a workstation; this is where it goes. */
  station?: DeskSlot
}

/** Where a person sits at a workstation: on the chair, behind the desk. */
export function seatPoint(slot: { x: number; y: number }): Point2 {
  return { x: slot.x + 0.85, y: slot.y + 0.45 }
}

export interface Prop {
  kind: 'plant'
  footprint: Rect
}

export interface OfficeMap {
  rooms: Room[]
  doors: Door[]
  /** The tall walls on the two far sides (windows are drawn on these). */
  outerWalls: Rect[]
  /** The low walls between rooms and around the reading alcove, in short pieces. */
  partitions: Rect[]
  /** Every desk there is room for, in the order employees fill them. */
  desks: DeskSlot[]
  places: Place[]
  props: Prop[]
  /** Extent of the floor, in tiles. */
  width: number
  depth: number
}

/** How many desk rooms a team of `employees` needs (at least one, at most the maximum). */
export function deskRoomsFor(employees: number): number {
  return Math.min(MAX_DESK_ROOMS, Math.max(1, Math.ceil(employees / DESKS_PER_ROOM)))
}

/** Desk positions inside a room, relative to its low corner: a 2x2 arrangement. */
const DESK_OFFSETS: readonly Point2[] = [
  { x: 1.2, y: 1.0 },
  { x: 5.4, y: 1.0 },
  { x: 1.2, y: 4.4 },
  { x: 5.4, y: 4.4 },
]

const ROOM_ORIGINS: readonly Point2[] = [
  { x: 0, y: 0 }, // desk room 1
  { x: ROOM_WIDTH, y: 0 }, // the commons room
  { x: 0, y: ROOM_DEPTH }, // desk room 2
  { x: ROOM_WIDTH, y: ROOM_DEPTH }, // desk room 3
]

const room = (id: string, kind: RoomKind, origin: Point2): Room => ({
  id,
  kind,
  rect: { x: origin.x, y: origin.y, w: ROOM_WIDTH, d: ROOM_DEPTH },
})

/** A run of wall along `axis` from `from` to `to`, in short pieces, leaving out any door gaps. */
function wallPieces(
  axis: 'x' | 'y',
  at: number,
  from: number,
  to: number,
  gaps: ReadonlyArray<{ from: number; to: number }>,
): Rect[] {
  const pieces: Rect[] = []
  const half = PARTITION_THICKNESS / 2
  const count = Math.ceil((to - from) / WALL_PIECE - 1e-9)
  for (let i = 0; i < count; i += 1) {
    // Whole steps from the start, so lengths do not drift; the last piece may be a little short.
    const start = from + i * WALL_PIECE
    const end = Math.min(start + WALL_PIECE, to)
    if (gaps.some((gap) => start >= gap.from - 1e-9 && end <= gap.to + 1e-9)) continue
    pieces.push(
      axis === 'x'
        ? { x: start, y: at - half, w: end - start, d: PARTITION_THICKNESS }
        : { x: at - half, y: start, w: PARTITION_THICKNESS, d: end - start },
    )
  }
  return pieces
}

function door(axis: 'x' | 'y', at: number, from: number, to: number): Door {
  const middle = (from + to) / 2
  return { axis, at, from, to, middle: axis === 'x' ? { x: middle, y: at } : { x: at, y: middle } }
}

const place = (
  id: string,
  kind: PlaceKind,
  label: string,
  footprint: Rect,
  slots: Point2[],
): Place => ({ id, kind, label, footprint, stand: slots[0] as Point2, slots })

/** Where the two reading desks go in the commons room, and how far back from the north wall. */
const READING_X = [3.4, 6.2] as const
const READING_Y = 3.9

/** A reading desk: a workstation whose front (south) is where to stand if not sitting at it. */
function readingDesk(
  id: string,
  x: number,
  y: number,
  station: (x: number, y: number) => DeskSlot,
): Place {
  // Far enough in front of the desk to be on open floor, and not into a wall behind it.
  const stand = { x: x + 0.85, y: y + STATION_DEPTH + 0.6 }
  return {
    ...place(id, 'reading', 'Reading room', { x, y, w: STATION_WIDTH, d: STATION_DEPTH }, [stand]),
    station: station(x, y),
  }
}

/** The shared places, in the commons room whose low corner is `o`. */
function commonsPlaces(o: Point2, station: (x: number, y: number) => DeskSlot): Place[] {
  const at = (x: number, y: number): Point2 => ({ x: o.x + x, y: o.y + y })
  const rect = (x: number, y: number, w: number, d: number): Rect => ({
    x: o.x + x,
    y: o.y + y,
    w,
    d,
  })
  return [
    place('board', 'board', 'Mission board', rect(0.9, 0, 3.0, 0.3), [at(2.4, 1.3)]),
    // Three people can stand at the bench at once.
    place('qa', 'qa', 'QA bench', rect(4.7, 0.25, 2.8, 0.8), [
      at(5.3, 1.8),
      at(6.1, 1.8),
      at(6.9, 1.8),
    ]),
    // Up from the front edge so there is open floor to stand on in front of it, wall or no wall.
    place('inbox', 'inbox', 'Your inbox', rect(1.0, 4.4, 2.0, 1.5), [at(2.0, 6.25)]),
    // Two reading desks with an aisle between them, so each can be got in and out of.
    readingDesk('reading-1', o.x + READING_X[0], o.y + READING_Y, station),
    readingDesk('reading-2', o.x + READING_X[1], o.y + READING_Y, station),
  ]
}

/** The floor plan for a team of `employees`. Deterministic: the same size always gives the same plan. */
export function buildOffice(employees: number): OfficeMap {
  const deskRooms = deskRoomsFor(employees)
  const first = room('desks-1', 'desks', ROOM_ORIGINS[0] as Point2)
  const commons = room('commons', 'commons', ROOM_ORIGINS[1] as Point2)
  const second = deskRooms >= 2 ? room('desks-2', 'desks', ROOM_ORIGINS[2] as Point2) : undefined
  const third = deskRooms >= 3 ? room('desks-3', 'desks', ROOM_ORIGINS[3] as Point2) : undefined
  const rooms = [first, commons, ...(second ? [second] : []), ...(third ? [third] : [])]

  // Doors between neighbouring rooms.
  // The first is centred in the 1.7-tile gap between the first room's desks.
  const doors: Door[] = [door('y', ROOM_WIDTH, 2.75, 4.25)]
  if (second) doors.push(door('x', ROOM_DEPTH, 3, 5))
  if (third) doors.push(door('x', ROOM_DEPTH, ROOM_WIDTH + 3, ROOM_WIDTH + 5))
  if (second && third) doors.push(door('y', ROOM_WIDTH, ROOM_DEPTH + 2.75, ROOM_DEPTH + 4.25))

  const width = ROOM_WIDTH * 2
  const depth = second || third ? ROOM_DEPTH * 2 : ROOM_DEPTH

  const outerWalls: Rect[] = [
    { x: 0, y: -0.2, w: width, d: 0.2 },
    { x: -0.2, y: 0, w: 0.2, d: second ? ROOM_DEPTH * 2 : ROOM_DEPTH },
  ]

  const gapsOn = (axis: 'x' | 'y', at: number) =>
    doors.filter((d) => d.axis === axis && d.at === at)
  const partitions: Rect[] = [
    // Between the first desk room and the commons room.
    ...wallPieces('y', ROOM_WIDTH, 0, ROOM_DEPTH, gapsOn('y', ROOM_WIDTH)),
  ]
  if (second)
    partitions.push(...wallPieces('x', ROOM_DEPTH, 0, ROOM_WIDTH, gapsOn('x', ROOM_DEPTH)))
  if (third) {
    partitions.push(
      ...wallPieces('x', ROOM_DEPTH, ROOM_WIDTH, width, gapsOn('x', ROOM_DEPTH)),
      ...wallPieces('y', ROOM_WIDTH, ROOM_DEPTH, depth, gapsOn('y', ROOM_WIDTH)),
    )
  }
  // The reading room is an alcove in the commons room: a wall behind the two desks. Its other sides
  // are open, so both desks can be got in and out of.
  const ox = ROOM_WIDTH
  partitions.push(...wallPieces('x', 3.5, ox + READING_X[0] - 0.1, ox + ROOM_WIDTH, []))

  const desks: DeskSlot[] = rooms
    .filter((r) => r.kind === 'desks')
    .flatMap((r) =>
      DESK_OFFSETS.map((offset) => ({
        x: r.rect.x + offset.x,
        y: r.rect.y + offset.y,
        roomId: r.id,
      })),
    )

  const places = commonsPlaces(ROOM_ORIGINS[1] as Point2, (x, y) => ({ x, y, roomId: 'commons' }))

  const props: Prop[] = [
    { kind: 'plant', footprint: { x: 7.3, y: 0.35, w: 0.4, d: 0.4 } },
    { kind: 'plant', footprint: { x: ROOM_WIDTH + 0.3, y: 0.35, w: 0.4, d: 0.4 } },
    ...(second
      ? [{ kind: 'plant' as const, footprint: { x: 0.3, y: ROOM_DEPTH + 0.35, w: 0.4, d: 0.4 } }]
      : []),
  ]

  return { rooms, doors, outerWalls, partitions, desks, places, props, width, depth }
}

/**
 * Join neighbouring wall pieces that run the same way into longer runs (at most `maxLength`), so a
 * run can be drawn as one thing. Nothing is lost: the runs cover exactly the pieces.
 */
export function groupWalls(pieces: readonly Rect[], maxLength = 1): Rect[] {
  const eps = 1e-6
  const runs: Rect[] = []
  for (const piece of pieces) {
    const last = runs.at(-1)
    if (last) {
      const alongX = Math.abs(last.y - piece.y) < eps && Math.abs(last.d - piece.d) < eps
      const alongY = Math.abs(last.x - piece.x) < eps && Math.abs(last.w - piece.w) < eps
      if (
        alongX &&
        Math.abs(last.x + last.w - piece.x) < eps &&
        last.w + piece.w <= maxLength + eps
      ) {
        last.w += piece.w
        continue
      }
      if (
        alongY &&
        Math.abs(last.y + last.d - piece.y) < eps &&
        last.d + piece.d <= maxLength + eps
      ) {
        last.d += piece.d
        continue
      }
    }
    runs.push({ ...piece })
  }
  return runs
}

/** Employees that get a desk, and how many are left over. */
export function assignDesks<T>(
  employees: readonly T[],
  map: OfficeMap,
): { seated: Array<{ employee: T; slot: DeskSlot }>; overflow: number } {
  const seated = employees
    .slice(0, map.desks.length)
    .map((employee, index) => ({ employee, slot: map.desks[index] as DeskSlot }))
  return { seated, overflow: Math.max(0, employees.length - map.desks.length) }
}

/** Whether two rectangles share any floor. Touching edges do not count (nor does rounding error). */
export function overlaps(a: Rect, b: Rect): boolean {
  const eps = 1e-9
  return (
    a.x < b.x + b.w - eps && b.x < a.x + a.w - eps && a.y < b.y + b.d - eps && b.y < a.y + a.d - eps
  )
}

/** The floor a workstation covers. */
export function stationRect(slot: { x: number; y: number }): Rect {
  return { x: slot.x, y: slot.y, w: STATION_WIDTH, d: STATION_DEPTH }
}

/**
 * How near a thing is to the camera, for painter's order (farthest drawn first): the sum of its
 * centre's coordinates. Exact when things are separated along an axis, which the plan keeps them.
 */
export function depthOf(rect: Rect): number {
  return rect.x + rect.w / 2 + rect.y + rect.d / 2
}
