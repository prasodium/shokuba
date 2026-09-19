import { describe, expect, it } from 'vitest'
import {
  DESKS_PER_ROOM,
  MAX_DESK_ROOMS,
  MAX_VISIBLE_EMPLOYEES,
  PARTITION_THICKNESS,
  ROOM_DEPTH,
  ROOM_WIDTH,
  assignDesks,
  buildOffice,
  depthOf,
  deskRoomsFor,
  groupWalls,
  overlaps,
  stationRect,
  type OfficeMap,
  type Point2,
  type Rect,
} from './map'

const inside = (p: Point2, r: Rect): boolean =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.d
const within = (inner: Rect, outer: Rect): boolean =>
  inner.x >= outer.x - 1e-9 &&
  inner.y >= outer.y - 1e-9 &&
  inner.x + inner.w <= outer.x + outer.w + 1e-9 &&
  inner.y + inner.d <= outer.y + outer.d + 1e-9

/** Everything that stands on the floor of a plan, with the reading stations counted once. */
function solids(map: OfficeMap): Array<{ name: string; rect: Rect }> {
  return [
    ...map.desks.map((slot, i) => ({ name: `desk ${i + 1}`, rect: stationRect(slot) })),
    ...map.places.map((p) => ({ name: p.id, rect: p.footprint })),
    ...map.props.map((p, i) => ({ name: `prop ${i + 1}`, rect: p.footprint })),
    ...map.partitions.map((r, i) => ({ name: `partition ${i + 1}`, rect: r })),
  ]
}

const SIZES = [0, 1, 4, 5, 8, 9, 12, 40]

describe('how big the office is', () => {
  it('needs a desk room for every four employees, at least one and at most three', () => {
    expect([0, 1, 4, 5, 8, 9, 12, 13, 100].map(deskRoomsFor)).toEqual([1, 1, 1, 2, 2, 3, 3, 3, 3])
    expect(MAX_VISIBLE_EMPLOYEES).toBe(DESKS_PER_ROOM * MAX_DESK_ROOMS)
    expect(MAX_VISIBLE_EMPLOYEES).toBe(12)
  })

  it('always has the commons room and a first desk room, and adds desk rooms as the team grows', () => {
    const kinds = (n: number) => buildOffice(n).rooms.map((r) => r.id)
    expect(kinds(0)).toEqual(['desks-1', 'commons'])
    expect(kinds(4)).toEqual(['desks-1', 'commons'])
    expect(kinds(5)).toEqual(['desks-1', 'commons', 'desks-2'])
    expect(kinds(9)).toEqual(['desks-1', 'commons', 'desks-2', 'desks-3'])
    expect(kinds(500)).toEqual(['desks-1', 'commons', 'desks-2', 'desks-3'])
  })

  it('has four desks for each desk room, and no more than twelve', () => {
    for (const [size, desks] of [
      [0, 4],
      [4, 4],
      [5, 8],
      [9, 12],
      [40, 12],
    ] as const) {
      expect(buildOffice(size).desks).toHaveLength(desks)
    }
  })

  it('is the same every time for the same size', () => {
    for (const size of SIZES) expect(buildOffice(size)).toEqual(buildOffice(size))
  })

  it('keeps the first rooms exactly where they were as the team grows, so nothing already there moves', () => {
    const small = buildOffice(4)
    for (const size of [5, 9]) {
      const bigger = buildOffice(size)
      expect(bigger.desks.slice(0, small.desks.length)).toEqual(small.desks)
      expect(bigger.places).toEqual(small.places)
      for (const roomInSmall of small.rooms) expect(bigger.rooms).toContainEqual(roomInSmall)
    }
  })
})

describe.each(SIZES)('a plan for %i employees', (size) => {
  const map = buildOffice(size)
  const floor = (): Rect[] => map.rooms.map((r) => r.rect)

  it('puts every desk, place and prop on the floor, inside a single room', () => {
    for (const { name, rect } of solids(map).filter((s) => !s.name.startsWith('partition'))) {
      const room = floor().find((r) => within(rect, r))
      expect(room, name).toBeDefined()
    }
  })

  it('never has two things in the same place', () => {
    const all = solids(map).filter((s) => !s.name.startsWith('partition'))
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        const a = all[i]
        const b = all[j]
        if (!a || !b) continue
        expect(overlaps(a.rect, b.rect), `${a.name} and ${b.name}`).toBe(false)
      }
    }
  })

  it('keeps every wall out of every desk, place and prop', () => {
    const things = solids(map).filter((s) => !s.name.startsWith('partition'))
    for (const wall of map.partitions) {
      for (const thing of things) {
        expect(overlaps(wall, thing.rect), thing.name).toBe(false)
      }
    }
  })

  it('leaves a clear way through every door, wide enough to walk', () => {
    const things = solids(map).filter((s) => !s.name.startsWith('partition'))
    const reach = 1.1 // how far either side of the doorway is kept clear
    for (const d of map.doors) {
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
      for (const thing of things) {
        expect(overlaps(before as Rect, thing.rect), `${thing.name} before a door`).toBe(false)
        expect(overlaps(after as Rect, thing.rect), `${thing.name} after a door`).toBe(false)
      }
      expect(d.to - d.from).toBeGreaterThanOrEqual(1.5)
    }
  })

  it('has no wall across a door, and a wall everywhere else along the boundary', () => {
    for (const d of map.doors) {
      const across = map.partitions.filter((wall) =>
        d.axis === 'y'
          ? Math.abs(wall.x + wall.w / 2 - d.at) < 1e-6 && wall.y < d.to && wall.y + wall.d > d.from
          : Math.abs(wall.y + wall.d / 2 - d.at) < 1e-6 &&
            wall.x < d.to &&
            wall.x + wall.w > d.from,
      )
      expect(across, 'a wall across a door').toEqual([])
    }
  })

  it('has somewhere to stand at every place, on the floor and clear of everything', () => {
    const others = solids(map)
    for (const place of map.places) {
      const room = floor().find((r) => inside(place.stand, r))
      expect(room, `${place.id} stand`).toBeDefined()
      for (const thing of others) {
        expect(inside(place.stand, thing.rect), `${place.id} stand inside ${thing.name}`).toBe(
          false,
        )
      }
    }
  })

  it('draws its walls in short pieces, so each can be put in depth order on its own', () => {
    for (const wall of map.partitions) {
      expect(Math.max(wall.w, wall.d)).toBeLessThanOrEqual(0.25 + 1e-9)
      // One side is the wall's thickness; the other is its length (the last piece of a run may be short).
      expect([wall.w, wall.d].some((side) => Math.abs(side - PARTITION_THICKNESS) < 1e-6)).toBe(
        true,
      )
      expect(wall.w).toBeGreaterThan(0)
      expect(wall.d).toBeGreaterThan(0)
    }
  })

  it('has tall walls only on the two far sides, out as far as the rooms go', () => {
    const [back, side] = map.outerWalls
    expect(back).toMatchObject({ x: 0, w: ROOM_WIDTH * 2 })
    expect(side).toMatchObject({ y: 0, d: map.depth })
    expect(map.width).toBe(ROOM_WIDTH * 2)
    expect(map.depth).toBe(size > DESKS_PER_ROOM ? ROOM_DEPTH * 2 : ROOM_DEPTH)
  })
})

describe('the shared places', () => {
  const map = buildOffice(1)
  const place = (id: string) => map.places.find((p) => p.id === id)

  it('are the person’s inbox, the QA bench, the mission board and two reading desks, all in the commons room', () => {
    expect(map.places.map((p) => p.id).sort()).toEqual(
      ['board', 'inbox', 'qa', 'reading-1', 'reading-2'].sort(),
    )
    const commons = map.rooms.find((r) => r.id === 'commons')?.rect as Rect
    for (const p of map.places) expect(within(p.footprint, commons), p.id).toBe(true)
  })

  it('have a name a person can read', () => {
    expect(place('inbox')?.label).toBe('Your inbox')
    expect(place('qa')?.label).toBe('QA bench')
    expect(place('board')?.label).toBe('Mission board')
    expect(place('reading-1')?.label).toBe('Reading room')
  })

  it('make a reading desk a workstation, so a reviewer can sit at it', () => {
    for (const id of ['reading-1', 'reading-2']) {
      const p = place(id)
      expect(p?.station).toBeDefined()
      expect(stationRect(p?.station as Point2)).toEqual(p?.footprint)
    }
    expect(place('inbox')?.station).toBeUndefined()
  })

  it('are the same wherever the team is, so a place never moves', () => {
    expect(buildOffice(12).places).toEqual(map.places)
  })
})

describe('the doors', () => {
  it('link neighbouring rooms, in the middle of a gap between them', () => {
    const map = buildOffice(12)
    expect(map.doors).toHaveLength(4)
    for (const d of map.doors) {
      expect(d.middle).toEqual(
        d.axis === 'y' ? { x: d.at, y: (d.from + d.to) / 2 } : { x: (d.from + d.to) / 2, y: d.at },
      )
    }
  })

  it('exist only for rooms that exist', () => {
    expect(buildOffice(1).doors).toHaveLength(1)
    expect(buildOffice(5).doors).toHaveLength(2)
    expect(buildOffice(9).doors).toHaveLength(4)
  })
})

describe('assignDesks', () => {
  const map = buildOffice(12)

  it('seats each employee at their own desk, in order', () => {
    const { seated, overflow } = assignDesks(['a', 'b'], map)
    expect(seated.map((s) => s.employee)).toEqual(['a', 'b'])
    expect(seated[0]?.slot).toEqual(map.desks[0])
    expect(seated[1]?.slot).toEqual(map.desks[1])
    expect(overflow).toBe(0)
  })

  it('fills one room before the next', () => {
    const { seated } = assignDesks(['a', 'b', 'c', 'd', 'e'], buildOffice(5))
    expect(seated.map((s) => s.slot.roomId)).toEqual([
      'desks-1',
      'desks-1',
      'desks-1',
      'desks-1',
      'desks-2',
    ])
  })

  it('reports how many did not fit', () => {
    const names = Array.from({ length: 15 }, (_, i) => `e${i}`)
    const { seated, overflow } = assignDesks(names, buildOffice(15))
    expect(seated).toHaveLength(12)
    expect(overflow).toBe(3)
  })

  it('handles an empty office', () => {
    expect(assignDesks([], buildOffice(0))).toEqual({ seated: [], overflow: 0 })
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
  const area = (rects: readonly Rect[]): number => rects.reduce((sum, r) => sum + r.w * r.d, 0)

  it('joins the pieces of a wall into runs no longer than asked, without losing any', () => {
    for (const size of [1, 5, 9]) {
      const { partitions } = buildOffice(size)
      const runs = groupWalls(partitions, 1)
      expect(area(runs)).toBeCloseTo(area(partitions), 6)
      expect(runs.length).toBeLessThan(partitions.length)
      for (const run of runs) expect(Math.max(run.w, run.d)).toBeLessThanOrEqual(1 + 1e-6)
    }
  })

  it('never joins pieces of different walls, or across a door', () => {
    const { partitions, doors } = buildOffice(9)
    const runs = groupWalls(partitions, 100) // as long as it likes: only walls and doors can stop it
    for (const run of runs) {
      for (const door of doors) {
        const across =
          door.axis === 'y'
            ? Math.abs(run.x + run.w / 2 - door.at) < 1e-6 &&
              run.y < door.from + 1e-6 &&
              run.y + run.d > door.to - 1e-6
            : Math.abs(run.y + run.d / 2 - door.at) < 1e-6 &&
              run.x < door.from + 1e-6 &&
              run.x + run.w > door.to - 1e-6
        expect(across, 'a run across a door').toBe(false)
      }
    }
    expect(runs.length).toBeGreaterThanOrEqual(5) // several separate walls
  })

  it('does not change the pieces it is given', () => {
    const { partitions } = buildOffice(1)
    const before = JSON.stringify(partitions)
    groupWalls(partitions)
    expect(JSON.stringify(partitions)).toBe(before)
  })

  it('gives nothing for nothing', () => {
    expect(groupWalls([])).toEqual([])
  })
})
