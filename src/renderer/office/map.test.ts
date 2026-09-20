import { describe, expect, it } from 'vitest'
import {
  BACK_STRIP,
  FLOOR_DEPTH,
  FLOOR_WIDTH,
  MAX_VISIBLE_EMPLOYEES,
  PARTITION_THICKNESS,
  WALL_PIECE,
  assignDesks,
  buildOffice,
  depthOf,
  groupWalls,
  overlaps,
  seatPoint,
  stationRect,
  type Point2,
  type Rect,
  type Seatable,
  type Wall,
} from './map'

const map = buildOffice()

const inside = (p: Point2, r: Rect): boolean =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.d
const within = (inner: Rect, outer: Rect): boolean =>
  inner.x >= outer.x - 1e-9 &&
  inner.y >= outer.y - 1e-9 &&
  inner.x + inner.w <= outer.x + outer.w + 1e-9 &&
  inner.y + inner.d <= outer.y + outer.d + 1e-9
const roomOf = (id: string): Rect => map.rooms.find((r) => r.id === id)?.rect as Rect

/** Everything that stands on the floor, by name. Walls are separate. */
function things(): Array<{ name: string; rect: Rect }> {
  return [
    ...map.desks.map((slot, i) => ({ name: `desk ${i + 1}`, rect: stationRect(slot) })),
    ...map.cabins.map((slot, i) => ({ name: `cabin desk ${i + 1}`, rect: stationRect(slot) })),
    ...map.places.map((p) => ({ name: p.id, rect: p.footprint })),
    ...map.props.map((p, i) => ({ name: `prop ${i + 1}`, rect: p.footprint })),
  ]
}

describe('the floor', () => {
  it('is the same every time, whatever the size of the team: it does not take one', () => {
    expect(buildOffice()).toEqual(buildOffice())
    expect(buildOffice.length).toBe(0)
  })

  it('is one rectangle, and its rooms fill it exactly, with no gap and no overlap', () => {
    expect([map.width, map.depth]).toEqual([FLOOR_WIDTH, FLOOR_DEPTH])
    const area = map.rooms.reduce((sum, r) => sum + r.rect.w * r.rect.d, 0)
    expect(area).toBeCloseTo(FLOOR_WIDTH * FLOOR_DEPTH, 6)
    const floor = { x: 0, y: 0, w: FLOOR_WIDTH, d: FLOOR_DEPTH }
    for (const room of map.rooms) expect(within(room.rect, floor), room.id).toBe(true)
    for (let i = 0; i < map.rooms.length; i += 1) {
      for (let j = i + 1; j < map.rooms.length; j += 1) {
        const a = map.rooms[i] as (typeof map.rooms)[number]
        const b = map.rooms[j] as (typeof map.rooms)[number]
        expect(overlaps(a.rect, b.rect), `${a.id} and ${b.id}`).toBe(false)
      }
    }
  })

  it('lays out like an office: pantry, manager cabin, your cabin and the lab along the back, the open desks below', () => {
    const [pantry, manager, yours, lab, open, meeting, reading] = [
      'pantry',
      'manager',
      'yours',
      'lab',
      'open',
      'meeting',
      'reading',
    ].map(roomOf) as Rect[]
    for (const back of [pantry, manager, yours, lab] as Rect[]) {
      expect(back.y).toBe(0)
      expect(back.d).toBe(BACK_STRIP)
    }
    // Side by side, in that order, edge to edge.
    expect((pantry as Rect).x + (pantry as Rect).w).toBe((manager as Rect).x)
    expect((manager as Rect).x + (manager as Rect).w).toBe((yours as Rect).x)
    expect((yours as Rect).x + (yours as Rect).w).toBe((lab as Rect).x)
    expect((lab as Rect).x + (lab as Rect).w).toBe(FLOOR_WIDTH)
    // The open area is below them, and the meeting and reading rooms sit to its right, one over the other.
    expect((open as Rect).y).toBe(BACK_STRIP)
    expect((open as Rect).x + (open as Rect).w).toBe((meeting as Rect).x)
    expect((meeting as Rect).y + (meeting as Rect).d).toBe((reading as Rect).y)
    expect((reading as Rect).y + (reading as Rect).d).toBe(FLOOR_DEPTH)
  })

  it('names the rooms that need a name', () => {
    expect(map.rooms.filter((r) => r.label).map((r) => [r.id, r.label])).toEqual([
      ['manager', 'Manager cabin'],
      ['meeting', 'Meeting room'],
    ])
  })

  it('has tall walls on the two far sides, the length of the floor', () => {
    const [back, side] = map.outerWalls
    expect(back).toMatchObject({ x: 0, w: FLOOR_WIDTH })
    expect(side).toMatchObject({ y: 0, d: FLOOR_DEPTH })
  })
})

describe('the desks', () => {
  it('are twelve in the open area and one in the manager cabin, and the office says so', () => {
    expect(map.desks).toHaveLength(12)
    expect(map.cabins).toHaveLength(1)
    expect(MAX_VISIBLE_EMPLOYEES).toBe(13)
    expect(map.desks.every((d) => d.kind === 'desk' && d.roomId === 'open')).toBe(true)
    expect(map.cabins.every((d) => d.kind === 'cabin' && d.roomId === 'manager')).toBe(true)
  })

  it('are in two rows of six, filled a column at a time, so four in a row are a block of two by two', () => {
    const ys = [...new Set(map.desks.map((d) => d.y))].sort((a, b) => a - b)
    expect(ys).toHaveLength(2)
    map.desks.forEach((desk, i) => {
      expect(desk.y).toBe(ys[i % 2])
      expect(desk.x).toBe((map.desks[i - (i % 2)] as (typeof map.desks)[number]).x) // a column shares its x
    })
    const xs = [...new Set(map.desks.map((d) => d.x))]
    expect(xs).toHaveLength(6)
    expect(xs).toEqual([...xs].sort((a, b) => a - b))
  })

  it('sit on the chair, behind the desk and inside the workstation, for every desk and reading desk', () => {
    const slots = [
      ...map.desks,
      ...map.cabins,
      ...map.places.flatMap((p) => (p.station ? [p.station] : [])),
    ]
    expect(slots).toHaveLength(15)
    for (const slot of slots) {
      const seat = seatPoint(slot)
      // The chair is drawn 0.55 to 1.17 across and 0.14 to 0.76 back; the desk starts at 0.86.
      expect(seat.x).toBeGreaterThan(slot.x + 0.55)
      expect(seat.x).toBeLessThan(slot.x + 1.17)
      expect(seat.y).toBeGreaterThan(slot.y + 0.14)
      expect(seat.y).toBeLessThan(slot.y + 0.76)
    }
  })
})

describe('everything on the floor', () => {
  it('is inside one room, and the right one', () => {
    for (const { name, rect } of things()) {
      expect(
        map.rooms.some((r) => within(rect, r.rect)),
        name,
      ).toBe(true)
    }
    const inRoom = (rect: Rect, id: string): boolean => within(rect, roomOf(id))
    for (const desk of map.cabins) expect(inRoom(stationRect(desk), 'manager')).toBe(true)
    for (const desk of map.desks) expect(inRoom(stationRect(desk), 'open')).toBe(true)
    const where: Record<string, string> = {
      tea: 'pantry',
      snacks: 'pantry',
      'pantry-table': 'pantry',
      inbox: 'yours',
      qa: 'lab',
      board: 'lab',
      'meeting-table': 'meeting',
      'reading-1': 'reading',
      'reading-2': 'reading',
    }
    for (const place of map.places)
      expect(inRoom(place.footprint, where[place.id] as string), place.id).toBe(true)
  })

  it('never shares floor with anything else', () => {
    const all = things()
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        const a = all[i] as (typeof all)[number]
        const b = all[j] as (typeof all)[number]
        expect(overlaps(a.rect, b.rect), `${a.name} and ${b.name}`).toBe(false)
      }
    }
  })

  it('is kept out of every wall', () => {
    for (const wall of map.walls) {
      for (const thing of things()) expect(overlaps(wall.rect, thing.rect), thing.name).toBe(false)
    }
  })
})

describe('the walls and doors', () => {
  it('are glass around the cabins and the meeting room, in short pieces so each can be depth-sorted', () => {
    expect(map.walls.length).toBeGreaterThan(100)
    expect(map.walls.every((w) => w.glass)).toBe(true)
    for (const { rect } of map.walls) {
      expect(Math.max(rect.w, rect.d)).toBeLessThanOrEqual(WALL_PIECE + 1e-9)
      // One side is the wall's thickness; the other is its length (the last piece of a run may be short).
      expect([rect.w, rect.d].some((side) => Math.abs(side - PARTITION_THICKNESS) < 1e-6)).toBe(
        true,
      )
      expect(rect.w).toBeGreaterThan(0)
      expect(rect.d).toBeGreaterThan(0)
    }
  })

  it('have a door into each cabin and the meeting room, wide enough to walk through', () => {
    expect(map.doors).toHaveLength(3)
    for (const door of map.doors) expect(door.to - door.from).toBeGreaterThanOrEqual(1.5)
    const into = (x: number, y: number): boolean =>
      map.doors.some((d) =>
        inside(
          { x, y },
          d.axis === 'x'
            ? { x: d.from, y: d.at, w: d.to - d.from, d: 0 }
            : { x: d.at, y: d.from, w: 0, d: d.to - d.from },
        ),
      )
    expect(into(8.5, BACK_STRIP)).toBe(true) // the manager cabin
    expect(into(13.5, BACK_STRIP)).toBe(true) // your cabin
    expect(into(18.2, 7.5)).toBe(true) // the meeting room
  })

  it('have nothing across the doorway, and a clear way either side', () => {
    const reach = 1.1
    for (const d of map.doors) {
      const across = map.walls.filter((wall) =>
        d.axis === 'y'
          ? Math.abs(wall.rect.x + wall.rect.w / 2 - d.at) < 1e-6 &&
            wall.rect.y < d.to &&
            wall.rect.y + wall.rect.d > d.from
          : Math.abs(wall.rect.y + wall.rect.d / 2 - d.at) < 1e-6 &&
            wall.rect.x < d.to &&
            wall.rect.x + wall.rect.w > d.from,
      )
      expect(across, 'a wall across a door').toEqual([])
      const [before, after]: Rect[] =
        d.axis === 'y'
          ? [
              { x: d.at - reach, y: d.from, w: reach, d: d.to - d.from },
              { x: d.at, y: d.from, w: reach, d: d.to - d.from },
            ]
          : [
              { x: d.from, y: d.at - reach, w: d.to - d.from, d: reach },
              { x: d.from, y: d.at, w: d.to - d.from, d: reach },
            ]
      for (const thing of things()) {
        expect(overlaps(before as Rect, thing.rect), `${thing.name} before a door`).toBe(false)
        expect(overlaps(after as Rect, thing.rect), `${thing.name} after a door`).toBe(false)
      }
    }
  })
})

describe('the shared places', () => {
  const place = (id: string) => map.places.find((p) => p.id === id)

  it('are the pantry (tea and coffee, snacks, a high table), your inbox, the lab (QA bench, board), the meeting table and two reading desks', () => {
    expect(map.places.map((p) => p.id).sort()).toEqual(
      [
        'board',
        'inbox',
        'meeting-table',
        'pantry-table',
        'qa',
        'reading-1',
        'reading-2',
        'snacks',
        'tea',
      ].sort(),
    )
  })

  it('have a name a person can read', () => {
    expect(place('tea')?.label).toBe('Tea & coffee')
    expect(place('snacks')?.label).toBe('Snacks')
    expect(place('inbox')?.label).toBe('Your inbox')
    expect(place('qa')?.label).toBe('QA bench')
    expect(place('board')?.label).toBe('Mission board')
    expect(place('reading-1')?.label).toBe('Reading room')
  })

  it('have room for the people they are for', () => {
    const slots = (id: string) => place(id)?.slots.length
    expect(slots('tea')).toBe(3)
    expect(slots('snacks')).toBe(2)
    expect(slots('pantry-table')).toBe(4)
    expect(slots('qa')).toBe(3)
    expect(slots('meeting-table')).toBe(6)
    expect(slots('inbox')).toBe(1)
    expect(slots('board')).toBe(1)
  })

  it('give somewhere to stand, first, on the floor and clear of everything, for every spot', () => {
    const floor = map.rooms.map((r) => r.rect)
    for (const p of map.places) {
      expect(p.stand).toEqual(p.slots[0])
      for (const slot of p.slots) {
        expect(
          floor.some((r) => inside(slot, r)),
          `${p.id} at ${JSON.stringify(slot)}`,
        ).toBe(true)
        for (const thing of things()) {
          if (thing.name === p.id && p.kind !== 'chat' && p.kind !== 'meeting') continue
          // A chair at a table stands beside it, so a table's own spots are next to it, not in it.
          expect(inside(slot, thing.rect), `${p.id} spot inside ${thing.name}`).toBe(false)
        }
      }
    }
  })

  it('make a reading desk a workstation, so a reviewer can sit at it', () => {
    for (const id of ['reading-1', 'reading-2']) {
      const p = place(id)
      expect(p?.station).toBeDefined()
      expect(stationRect(p?.station as Point2)).toEqual(p?.footprint)
    }
    expect(place('inbox')?.station).toBeUndefined()
  })

  it('leave an aisle between the two reading desks, so each can be got in and out of', () => {
    const [a, b] = ['reading-1', 'reading-2'].map((id) => place(id)?.footprint) as Rect[]
    expect((b as Rect).x - ((a as Rect).x + (a as Rect).w)).toBeGreaterThanOrEqual(1)
  })
})

const person = (id: string, extra: Partial<Seatable> = {}): Seatable => ({ id, ...extra })

describe('who sits where', () => {
  it('seats a manager in the cabin, and everyone else in the open, in order', () => {
    const { seated, overflow } = assignDesks(
      [person('kai'), person('mira', { isManager: true }), person('ada')],
      map,
    )
    expect(overflow).toBe(0)
    const at = (id: string) => seated.find((s) => s.employee.id === id)?.slot
    expect(at('mira')).toEqual(map.cabins[0])
    expect(at('kai')).toEqual(map.desks[0])
    expect(at('ada')).toEqual(map.desks[1])
  })

  it('seats a manager’s team together, straight after the open desks of anyone who came first', () => {
    const people = [
      person('solo'),
      person('mira', { isManager: true }),
      person('ada', { reportsTo: 'mira' }),
      person('kai'),
      person('sora', { reportsTo: 'mira' }),
    ]
    const { seated } = assignDesks(people, map)
    const order = seated.filter((s) => s.slot.kind === 'desk').map((s) => s.employee.id)
    // The team first (in the order given), then everyone with no manager.
    expect(order).toEqual(['ada', 'sora', 'solo', 'kai'])
    // Which puts the team in a block: the first two open desks are one column.
    const [first, second] = seated.filter(
      (s) => s.employee.id === 'ada' || s.employee.id === 'sora',
    )
    expect((first as (typeof seated)[number]).slot.x).toBe(
      (second as (typeof seated)[number]).slot.x,
    )
  })

  it('seats a second manager in the open, at the head of their team, since there is one cabin', () => {
    const { seated } = assignDesks(
      [
        person('mira', { isManager: true }),
        person('noor', { isManager: true }),
        person('ren', { reportsTo: 'noor' }),
      ],
      map,
    )
    expect(seated.find((s) => s.employee.id === 'mira')?.slot).toEqual(map.cabins[0])
    const open = seated.filter((s) => s.slot.kind === 'desk').map((s) => s.employee.id)
    expect(open).toEqual(['noor', 'ren'])
  })

  it('does not lose someone whose manager is not in the office, and seats them with the rest', () => {
    const { seated } = assignDesks([person('ada', { reportsTo: 'gone' }), person('kai')], map)
    expect(seated.map((s) => s.employee.id)).toEqual(['ada', 'kai'])
  })

  it('never seats two people at one desk', () => {
    const people = Array.from({ length: 13 }, (_, i) =>
      person(`e${i}`, i === 0 ? { isManager: true } : {}),
    )
    const { seated, overflow } = assignDesks(people, map)
    expect(overflow).toBe(0)
    expect(seated).toHaveLength(13)
    const keys = seated.map((s) => `${s.slot.x},${s.slot.y}`)
    expect(new Set(keys).size).toBe(13)
  })

  it('counts, and does not seat, whoever there is no desk for', () => {
    const people = Array.from({ length: 16 }, (_, i) =>
      person(`e${i}`, i === 0 ? { isManager: true } : {}),
    )
    const { seated, overflow } = assignDesks(people, map)
    expect(seated).toHaveLength(13)
    expect(overflow).toBe(3)
    expect(seated.map((s) => s.employee.id)).not.toContain('e15')
  })

  it('handles an empty office, and gives the same seating for the same people', () => {
    expect(assignDesks([], map)).toEqual({ seated: [], overflow: 0 })
    const people = [person('a', { isManager: true }), person('b', { reportsTo: 'a' }), person('c')]
    expect(assignDesks(people, map)).toEqual(assignDesks(people, map))
  })
})

describe('overlaps and depth', () => {
  it('counts a shared edge as not overlapping, even with a rounding error in it', () => {
    const a = { x: 0, y: 0, w: 2, d: 2 }
    expect(overlaps({ x: 12.4, y: 0, w: 1.8, d: 1 }, { x: 14.2, y: 0, w: 1.8, d: 1 })).toBe(false)
    expect(overlaps(a, { x: 2, y: 0, w: 1, d: 1 })).toBe(false)
    expect(overlaps(a, { x: 1.9, y: 0, w: 1, d: 1 })).toBe(true)
    expect(overlaps(a, { x: 0, y: 2, w: 1, d: 1 })).toBe(false)
  })

  it('orders things from far to near by the sum of their centre’s coordinates', () => {
    const far = { x: 0, y: 0, w: 1, d: 1 }
    const near = { x: 4, y: 3, w: 1, d: 1 }
    expect(depthOf(far)).toBeLessThan(depthOf(near))
    expect(depthOf({ x: 1, y: 1, w: 2, d: 2 })).toBe(4)
  })
})

describe('groupWalls', () => {
  const area = (walls: readonly Wall[]): number =>
    walls.reduce((sum, w) => sum + w.rect.w * w.rect.d, 0)

  it('joins the pieces of a wall into runs no longer than asked, without losing any', () => {
    const runs = groupWalls(map.walls, 1)
    expect(area(runs)).toBeCloseTo(area(map.walls), 6)
    expect(runs.length).toBeLessThan(map.walls.length)
    for (const run of runs) expect(Math.max(run.rect.w, run.rect.d)).toBeLessThanOrEqual(1 + 1e-6)
  })

  it('never joins pieces of different walls, or across a door', () => {
    const runs = groupWalls(map.walls, 100) // as long as it likes: only walls and doors can stop it
    for (const { rect } of runs) {
      for (const door of map.doors) {
        const across =
          door.axis === 'y'
            ? Math.abs(rect.x + rect.w / 2 - door.at) < 1e-6 &&
              rect.y < door.from + 1e-6 &&
              rect.y + rect.d > door.to - 1e-6
            : Math.abs(rect.y + rect.d / 2 - door.at) < 1e-6 &&
              rect.x < door.from + 1e-6 &&
              rect.x + rect.w > door.to - 1e-6
        expect(across, 'a run across a door').toBe(false)
      }
    }
    expect(runs.length).toBeGreaterThanOrEqual(8) // separate walls
  })

  it('keeps glass and low walls apart, even end to end', () => {
    const piece = (x: number, glass: boolean): Wall => ({
      glass,
      rect: { x, y: 0, w: 0.25, d: PARTITION_THICKNESS },
    })
    const runs = groupWalls(
      [piece(0, true), piece(0.25, true), piece(0.5, false), piece(0.75, false)],
      10,
    )
    expect(runs.map((r) => [r.glass, r.rect.w])).toEqual([
      [true, 0.5],
      [false, 0.5],
    ])
  })

  it('does not change the pieces it is given', () => {
    const before = JSON.stringify(map.walls)
    groupWalls(map.walls)
    expect(JSON.stringify(map.walls)).toBe(before)
  })

  it('gives nothing for nothing', () => {
    expect(groupWalls([])).toEqual([])
  })
})
