/**
 * The office's floor plan, as data. Pure, so it can be tested without drawing anything: the
 * rooms, walls and doors, where each desk goes, and where the shared places are.
 *
 * It is one rectangular floor, laid out like a real office. Along the back wall: a pantry (a tea
 * and coffee counter, a snack shelf, a high table), a glass-walled manager cabin, your own cabin
 * (where finished work lands), and the lab (the QA bench and the mission board). Below them, the
 * open desk area, where a team sits together, and to its right a glass-walled meeting room and the
 * reading room. The plan is the same for every team size: people are seated into it, and the
 * empty desks are simply empty.
 *
 *        x ->   0        6       11       16          24
 *   y    0     +--------+--------+--------+-----------+
 *   |          | pantry |manager | your   |   lab     |   back wall: tall, with windows
 *   v   5.5    +--------+--cabin--+-cabin--+-----------+
 *              |  open desks (12)          | meeting   |
 *              |                           +-----------+
 *              |                           | reading   |
 *   14         +---------------------------+-----------+
 *
 * Units are floor tiles. x grows to the lower right on screen and y to the lower left; the far
 * corner is (0, 0). The near sides are open, as in a cutaway.
 */

export const FLOOR_WIDTH = 24
export const FLOOR_DEPTH = 14
/** How deep the strip of pantry, cabins and lab along the back wall is. */
export const BACK_STRIP = 5.5

export const WALL_HEIGHT = 2.8
export const PARTITION_HEIGHT = 0.95
/** Glass walls are as tall as a person and a little, so you see through to what is inside. */
export const GLASS_HEIGHT = 2.2
export const PARTITION_THICKNESS = 0.16
/** Length of one piece of wall, so each piece can be depth-sorted on its own. */
export const WALL_PIECE = 0.25

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

export type RoomKind = 'pantry' | 'cabin' | 'yours' | 'lab' | 'open' | 'meeting' | 'reading'

export interface Room {
  id: string
  kind: RoomKind
  rect: Rect
  /** A name to show over the room, if it needs one. */
  label?: string
}

/** A wall between rooms, or around one. Glass is tall and see-through; the rest is low and solid. */
export interface Wall {
  rect: Rect
  glass: boolean
}

/** Low corner of a workstation's footprint. */
export interface DeskSlot {
  x: number
  y: number
  roomId: string
  /** A manager's desk in a cabin, or one in the open area. */
  kind: 'desk' | 'cabin'
}

/** A gap in a wall. `axis` is the direction the wall runs along. */
export interface Door {
  axis: 'x' | 'y'
  /** The wall's fixed coordinate: y for a wall running along x, x for one along y. */
  at: number
  from: number
  to: number
  /** Where a person crosses, in the middle of the gap. */
  middle: Point2
}

export type PlaceKind = 'inbox' | 'qa' | 'reading' | 'board' | 'tea' | 'snacks' | 'meeting' | 'chat'

/** Something in the office that stands for something real, or is somewhere to be. */
export interface Place {
  id: string
  kind: PlaceKind
  label: string
  footprint: Rect
  /** Where someone stands to use it (on the floor, clear of furniture). */
  stand: Point2
  /**
   * Every spot where someone can be at once (`stand` is the first). A place that only one person can
   * use at a time has one.
   */
  slots: Point2[]
  /** A reading place is a workstation; this is where it goes. */
  station?: DeskSlot
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
  /** The glass and low walls inside, in short pieces. */
  walls: Wall[]
  /** The desks in the open area, in the order people fill them (a team sits in a block). */
  desks: DeskSlot[]
  /** The desks in the manager cabins. */
  cabins: DeskSlot[]
  places: Place[]
  props: Prop[]
  /** Extent of the floor, in tiles. */
  width: number
  depth: number
}

/** Where a person sits at a workstation: on the chair, behind the desk. */
export function seatPoint(slot: { x: number; y: number }): Point2 {
  return { x: slot.x + 0.85, y: slot.y + 0.45 }
}

/** How many people there are desks for: the open ones and the cabin. */
export const MAX_VISIBLE_EMPLOYEES = 13

const room = (
  id: string,
  kind: RoomKind,
  x: number,
  y: number,
  w: number,
  d: number,
  label?: string,
): Room => ({
  id,
  kind,
  rect: { x, y, w, d },
  ...(label && { label }),
})

/** The rooms, which tile the whole floor without gaps or overlaps. */
const ROOMS: readonly Room[] = [
  room('pantry', 'pantry', 0, 0, 6, BACK_STRIP),
  room('manager', 'cabin', 6, 0, 5, BACK_STRIP, 'Manager cabin'),
  room('yours', 'yours', 11, 0, 5, BACK_STRIP),
  room('lab', 'lab', 16, 0, 8, BACK_STRIP),
  room('open', 'open', 0, BACK_STRIP, 18.2, FLOOR_DEPTH - BACK_STRIP),
  room('meeting', 'meeting', 18.2, BACK_STRIP, 5.8, 4.4, 'Meeting room'),
  room('reading', 'reading', 18.2, BACK_STRIP + 4.4, 5.8, FLOOR_DEPTH - BACK_STRIP - 4.4),
]

/** The open desks: six columns of two, so the people of one team sit in a block. */
const DESK_X0 = 0.7
const DESK_PITCH = 2.85
const DESK_ROWS = [7.0, 10.6] as const

/** Where the two reading desks go. */
const READING_X = [18.6, 21.6] as const
const READING_Y = 10.6

/** A run of wall along `axis` from `from` to `to`, in short pieces, leaving out any door gaps. */
function wallPieces(
  axis: 'x' | 'y',
  at: number,
  from: number,
  to: number,
  glass: boolean,
  gaps: ReadonlyArray<{ from: number; to: number }> = [],
): Wall[] {
  const pieces: Wall[] = []
  const half = PARTITION_THICKNESS / 2
  const count = Math.ceil((to - from) / WALL_PIECE - 1e-9)
  for (let i = 0; i < count; i += 1) {
    // Whole steps from the start, so lengths do not drift; the last piece may be a little short.
    const start = from + i * WALL_PIECE
    const end = Math.min(start + WALL_PIECE, to)
    if (gaps.some((gap) => start >= gap.from - 1e-9 && end <= gap.to + 1e-9)) continue
    pieces.push({
      glass,
      rect:
        axis === 'x'
          ? { x: start, y: at - half, w: end - start, d: PARTITION_THICKNESS }
          : { x: at - half, y: start, w: PARTITION_THICKNESS, d: end - start },
    })
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

/** A reading desk: a workstation whose front (south) is where to stand if not sitting at it. */
function readingDesk(id: string, x: number, y: number): Place {
  // Far enough in front of the desk to be on open floor, and not into a wall behind it.
  const stand = { x: x + 0.85, y: y + STATION_DEPTH + 0.6 }
  return {
    ...place(id, 'reading', 'Reading room', { x, y, w: STATION_WIDTH, d: STATION_DEPTH }, [stand]),
    station: { x, y, roomId: 'reading', kind: 'desk' },
  }
}

/** The floor plan. The same every time: it does not depend on how many people there are. */
export function buildOffice(): OfficeMap {
  const doors: Door[] = [
    door('x', BACK_STRIP, 7.75, 9.25), // into the manager cabin
    door('x', BACK_STRIP, 12.75, 14.25), // into your cabin
    door('y', 18.2, 7.0, 8.5), // into the meeting room
  ]
  const gaps = (axis: 'x' | 'y', at: number) => doors.filter((d) => d.axis === axis && d.at === at)

  const walls: Wall[] = [
    // The cabins: glass down each side, and along the front with a door.
    ...wallPieces('y', 6, 0, BACK_STRIP, true),
    ...wallPieces('y', 11, 0, BACK_STRIP, true),
    ...wallPieces('y', 16, 0, BACK_STRIP, true),
    ...wallPieces('x', BACK_STRIP, 6, 11, true, gaps('x', BACK_STRIP)),
    ...wallPieces('x', BACK_STRIP, 11, 16, true, gaps('x', BACK_STRIP)),
    // The meeting room: glass on three sides, open on the outside edge.
    ...wallPieces('y', 18.2, BACK_STRIP, 9.9, true, gaps('y', 18.2)),
    ...wallPieces('x', BACK_STRIP, 18.2, FLOOR_WIDTH, true),
    ...wallPieces('x', 9.9, 18.2, FLOOR_WIDTH, true),
  ]

  const desks: DeskSlot[] = []
  for (let column = 0; column < 6; column += 1) {
    for (const y of DESK_ROWS) {
      desks.push({ x: DESK_X0 + column * DESK_PITCH, y, roomId: 'open', kind: 'desk' })
    }
  }
  const cabins: DeskSlot[] = [{ x: 7.6, y: 1.2, roomId: 'manager', kind: 'cabin' }]

  const places: Place[] = [
    place('tea', 'tea', 'Tea & coffee', { x: 0.6, y: 0.05, w: 3.0, d: 0.9 }, [
      { x: 1.2, y: 1.6 },
      { x: 2.1, y: 1.6 },
      { x: 3.0, y: 1.6 },
    ]),
    place('snacks', 'snacks', 'Snacks', { x: 4.0, y: 0.05, w: 1.8, d: 0.8 }, [
      { x: 4.5, y: 1.6 },
      { x: 5.3, y: 1.6 },
    ]),
    place('pantry-table', 'chat', 'Pantry table', { x: 2.0, y: 3.0, w: 1.6, d: 1.0 }, [
      { x: 1.6, y: 3.5 },
      { x: 4.0, y: 3.5 },
      { x: 2.8, y: 2.3 },
      { x: 2.8, y: 4.75 },
    ]),
    // Your cabin: the desk where finished work lands.
    place('inbox', 'inbox', 'Your inbox', { x: 12.0, y: 1.3, w: 2.0, d: 1.5 }, [
      { x: 13.0, y: 3.4 },
    ]),
    // The lab, along the back wall: three people can stand at the bench at once.
    place('qa', 'qa', 'QA bench', { x: 17.0, y: 0.25, w: 2.8, d: 0.8 }, [
      { x: 17.6, y: 1.8 },
      { x: 18.4, y: 1.8 },
      { x: 19.2, y: 1.8 },
    ]),
    place('board', 'board', 'Mission board', { x: 20.2, y: 0, w: 3.0, d: 0.3 }, [
      { x: 21.7, y: 1.3 },
    ]),
    // The meeting table, with a place at each of six chairs.
    place('meeting-table', 'meeting', 'Meeting room', { x: 19.6, y: 7.0, w: 3.0, d: 1.4 }, [
      { x: 20.0, y: 6.4 },
      { x: 21.1, y: 6.4 },
      { x: 22.2, y: 6.4 },
      { x: 20.0, y: 9.0 },
      { x: 21.1, y: 9.0 },
      { x: 22.2, y: 9.0 },
    ]),
    // Two reading desks with an aisle between them, so each can be got in and out of.
    readingDesk('reading-1', READING_X[0], READING_Y),
    readingDesk('reading-2', READING_X[1], READING_Y),
  ]

  const props: Prop[] = [
    { kind: 'plant', footprint: { x: 10.3, y: 0.4, w: 0.4, d: 0.4 } },
    { kind: 'plant', footprint: { x: 15.2, y: 0.4, w: 0.4, d: 0.4 } },
    { kind: 'plant', footprint: { x: 0.3, y: 12.9, w: 0.4, d: 0.4 } },
    { kind: 'plant', footprint: { x: 17.5, y: 12.9, w: 0.4, d: 0.4 } },
  ]

  return {
    rooms: [...ROOMS],
    doors,
    outerWalls: [
      { x: 0, y: -0.2, w: FLOOR_WIDTH, d: 0.2 },
      { x: -0.2, y: 0, w: 0.2, d: FLOOR_DEPTH },
    ],
    walls,
    desks,
    cabins,
    places,
    props,
    width: FLOOR_WIDTH,
    depth: FLOOR_DEPTH,
  }
}

/** What the office needs to know about someone to seat them. */
export interface Seatable {
  id: string
  isManager?: boolean
  reportsTo?: string | null
}

/**
 * Who sits where. A manager takes a cabin (as many as there are), and everyone else takes the open
 * desks in order, with each manager's team together (a manager without a cabin at the head of theirs)
 * and people with no manager after them. The order among equals is the order given. Whoever does not
 * fit is counted, not seated.
 */
export function assignDesks<T extends Seatable>(
  employees: readonly T[],
  map: OfficeMap,
): { seated: Array<{ employee: T; slot: DeskSlot }>; overflow: number } {
  const managers = employees.filter((e) => e.isManager === true)
  const inCabins = managers.slice(0, map.cabins.length)
  const inCabin = new Set(inCabins.map((m) => m.id))
  const managerIds = new Set(managers.map((m) => m.id))

  const seated: Array<{ employee: T; slot: DeskSlot }> = inCabins.map((employee, i) => ({
    employee,
    slot: map.cabins[i] as DeskSlot,
  }))

  const inOrder: T[] = []
  for (const manager of managers) {
    if (!inCabin.has(manager.id)) inOrder.push(manager)
    for (const e of employees) {
      if (e.isManager !== true && e.reportsTo === manager.id) inOrder.push(e)
    }
  }
  for (const e of employees) {
    if (e.isManager === true) continue
    if (e.reportsTo != null && managerIds.has(e.reportsTo)) continue // seated with their manager
    inOrder.push(e)
  }

  const open = inOrder.slice(0, map.desks.length)
  open.forEach((employee, i) => seated.push({ employee, slot: map.desks[i] as DeskSlot }))
  return { seated, overflow: Math.max(0, inOrder.length - map.desks.length) }
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
 * Join neighbouring wall pieces of the same kind that run the same way into longer runs (at most
 * `maxLength`), so a run can be drawn as one thing. Nothing is lost: the runs cover exactly the pieces.
 */
export function groupWalls(pieces: readonly Wall[], maxLength = 1): Wall[] {
  const eps = 1e-6
  const runs: Wall[] = []
  for (const piece of pieces) {
    const last = runs.at(-1)
    if (last && last.glass === piece.glass) {
      const a = last.rect
      const b = piece.rect
      const alongX = Math.abs(a.y - b.y) < eps && Math.abs(a.d - b.d) < eps
      const alongY = Math.abs(a.x - b.x) < eps && Math.abs(a.w - b.w) < eps
      if (alongX && Math.abs(a.x + a.w - b.x) < eps && a.w + b.w <= maxLength + eps) {
        a.w += b.w
        continue
      }
      if (alongY && Math.abs(a.y + a.d - b.y) < eps && a.d + b.d <= maxLength + eps) {
        a.d += b.d
        continue
      }
    }
    runs.push({ glass: piece.glass, rect: { ...piece.rect } })
  }
  return runs
}

/**
 * How near a thing is to the camera, for painter's order (farthest drawn first): the sum of its
 * centre's coordinates. Exact when things are separated along an axis, which the plan keeps them.
 */
export function depthOf(rect: Rect): number {
  return rect.x + rect.w / 2 + rect.y + rect.d / 2
}
