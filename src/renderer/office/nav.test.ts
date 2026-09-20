import { describe, expect, it } from 'vitest'
import { buildOffice, seatPoint, stationRect, type OfficeMap, type Point2 } from './map'
import {
  CELL,
  WALKER_RADIUS,
  buildNavGrid,
  cellOf,
  findPath,
  isFreePoint,
  lineClear,
  nearestFree,
  pathLength,
  reachableFrom,
  seatExit,
  solidsOf,
  type NavGrid,
} from './nav'

/** A grid drawn as text: `#` is blocked, anything else is free. Each character is one cell. */
function draw(...rows: string[]): NavGrid {
  return {
    cols: (rows[0] ?? '').length,
    rows: rows.length,
    blocked: Uint8Array.from(
      rows
        .join('')
        .split('')
        .map((c) => (c === '#' ? 1 : 0)),
    ),
  }
}
const at = (col: number, row: number): Point2 => ({ x: (col + 0.5) * CELL, y: (row + 0.5) * CELL })
const along = (points: readonly Point2[]): Point2[] => {
  const out: Point2[] = []
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1] as Point2
    const b = points[i] as Point2
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.05)
    for (let k = 0; k <= steps; k += 1)
      out.push({ x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps })
  }
  return out
}

describe('finding a way', () => {
  it('goes straight across open floor', () => {
    const grid = draw('........', '........', '........', '........')
    const path = findPath(grid, at(0, 0), at(7, 3)) as Point2[]
    expect(path).toEqual([at(0, 0), at(7, 3)])
    expect(pathLength(path)).toBeCloseTo(Math.hypot(7 * CELL, 3 * CELL))
  })

  it('goes round a wall through the gap in it, never through the wall', () => {
    const grid = draw('...#....', '...#....', '........', '...#....', '...#....')
    const path = findPath(grid, at(0, 0), at(7, 0)) as Point2[]
    expect(path[0]).toEqual(at(0, 0))
    expect(path.at(-1)).toEqual(at(7, 0))
    expect(pathLength(path)).toBeGreaterThan(7 * CELL)
    for (const point of along(path))
      expect(isFreePoint(grid, point), JSON.stringify(point)).toBe(true)
    expect(path.some((p) => Math.abs(p.y - at(0, 2).y) < 0.3 && p.x > 1 && p.x < 2)).toBe(true) // through the gap
  })

  it('does not cut a corner, so nobody squeezes between two blocks that only touch', () => {
    expect(findPath(draw('.#', '#.'), at(0, 0), at(1, 1))).toBeNull()
    // With one side open the same diagonal is fine, and goes by the open side.
    const open = findPath(draw('..', '#.'), at(0, 0), at(1, 1)) as Point2[]
    expect(open).not.toBeNull()
    for (const point of along(open)) expect(isFreePoint(draw('..', '#.'), point)).toBe(true)
  })

  it('says there is no way to somewhere that is walled in', () => {
    const grid = draw('.....', '.###.', '.#.#.', '.###.', '.....')
    expect(findPath(grid, at(0, 0), at(2, 2))).toBeNull()
  })

  it('starts from a blocked cell, such as a seat, from the nearest free one, and joins the two', () => {
    const grid = draw('.....', '..#..', '.....')
    const seat = at(2, 1)
    const path = findPath(grid, seat, at(4, 2)) as Point2[]
    expect(path[0]).toEqual(seat)
    expect(path.at(-1)).toEqual(at(4, 2))
    expect(path.length).toBeGreaterThanOrEqual(2)
  })

  it('finds the shortest way, straightened: an L-shaped corridor is one corner', () => {
    const grid = draw('.####', '.####', '.....')
    const path = findPath(grid, at(0, 0), at(4, 2)) as Point2[]
    expect(path).toHaveLength(3)
    expect(path[1]).toEqual(at(0, 2))
  })

  it('is never longer than walking cell to cell, nor shorter than a straight line', () => {
    const grid = draw('........', '.#####..', '.#......', '.#.####.', '...#....')
    const from = at(0, 0)
    const to = at(7, 4)
    const path = findPath(grid, from, to) as Point2[]
    const direct = Math.hypot(to.x - from.x, to.y - from.y)
    expect(pathLength(path)).toBeGreaterThanOrEqual(direct - 1e-9)
    for (const point of along(path)) expect(isFreePoint(grid, point)).toBe(true)
  })

  it('gives the same way every time', () => {
    const grid = draw('.....', '.###.', '.....')
    expect(findPath(grid, at(0, 0), at(4, 2))).toEqual(findPath(grid, at(0, 0), at(4, 2)))
  })

  it('gives nothing when there is nowhere near to stand', () => {
    const wall = draw('####', '####')
    expect(findPath(wall, at(0, 0), at(3, 1))).toBeNull()
    expect(nearestFree(wall, at(1, 1))).toBeNull()
  })

  it('counts only what can really be walked to: two blocks that merely touch at a corner do not join floors', () => {
    const grid = draw('.#.', '#.#', '.#.')
    const reach = reachableFrom(grid, at(0, 0))
    expect([...reach]).toEqual([0]) // just the cell they stand in
    const open = draw('..', '..')
    expect(reachableFrom(open, at(0, 0)).size).toBe(4)
  })

  it('sees a blocked cell that a line only clips the corner of, which spot checks along it would miss', () => {
    // The line from (0.2, 0.75) to (2.4, 0.2) grazes the top-left corner of the blocked cell below.
    const grid = draw('.....', '..#..', '.....')
    const a = { x: 0.2, y: 1.55 }
    const b = { x: 2.4, y: 0.9 }
    expect(lineClear(grid, a, b)).toBe(false)
    // Well clear of it, the same kind of line is fine.
    expect(lineClear(grid, { x: 0.2, y: 0.4 }, { x: 2.4, y: 0.3 })).toBe(true)
  })

  it('does not slip diagonally between two blocks that only touch at a corner', () => {
    const grid = draw('.#.', '#..', '...')
    expect(lineClear(grid, at(0, 0), at(1, 1))).toBe(false) // through the corner of two blocked cells
    const one = draw('..', '#.')
    expect(lineClear(one, at(0, 0), at(1, 1))).toBe(false) // one side blocked is enough
    expect(lineClear(draw('..', '..'), at(0, 0), at(1, 1))).toBe(true)
  })

  it('walks straight along a row or a column, and both ways', () => {
    const grid = draw('.....', '.#...', '.....')
    expect(lineClear(grid, at(0, 0), at(4, 0))).toBe(true)
    expect(lineClear(grid, at(4, 0), at(0, 0))).toBe(true)
    expect(lineClear(grid, at(0, 0), at(0, 2))).toBe(true)
    expect(lineClear(grid, at(1, 0), at(1, 2))).toBe(false)
    expect(lineClear(grid, at(1, 2), at(1, 0))).toBe(false)
  })

  it('needs both ends to be free, and stay on the grid', () => {
    const grid = draw('.#.', '...')
    expect(lineClear(grid, at(1, 0), at(2, 1))).toBe(false) // starts in a block
    expect(lineClear(grid, at(0, 0), at(1, 0))).toBe(false) // ends in a block
    expect(lineClear(grid, at(0, 0), { x: 9, y: 0.25 })).toBe(false) // off the edge
    expect(lineClear(grid, at(0, 0), at(0, 0))).toBe(true) // going nowhere
  })

  it('says whether a straight line is clear', () => {
    const grid = draw('.....', '..#..', '.....')
    expect(lineClear(grid, at(0, 0), at(4, 0))).toBe(true)
    expect(lineClear(grid, at(0, 1), at(4, 1))).toBe(false)
    expect(lineClear(grid, at(0, 0), at(9, 0))).toBe(false) // off the edge
  })
})

describe('the floor of the office', () => {
  const map: OfficeMap = buildOffice()
  const grid = buildNavGrid(map)

  it('is not walkable where there are desks, walls, furniture or plants', () => {
    // Listed one by one here, not through the same function the grid is built from.
    const solids = [
      ...map.desks.map(stationRect),
      ...map.cabins.map(stationRect),
      ...map.places.map((place) => place.footprint),
      ...map.props.map((prop) => prop.footprint),
      ...map.walls.map((wall) => wall.rect),
    ]
    expect(solids.length).toBeGreaterThan(50)
    for (const solid of solids) {
      const middle = { x: solid.x + solid.w / 2, y: solid.y + solid.d / 2 }
      expect(isFreePoint(grid, middle), JSON.stringify(solid)).toBe(false)
    }
  })

  it('is not walkable off the floor', () => {
    for (const point of [
      { x: -0.4, y: 1 },
      { x: 1, y: -0.4 },
      { x: map.width + 0.4, y: 1 },
      { x: 1, y: map.depth + 0.4 },
    ]) {
      expect(isFreePoint(grid, point), JSON.stringify(point)).toBe(false)
    }
  })

  it('keeps a walker’s width clear of every solid, so a path never brushes one', () => {
    for (let row = 0; row < grid.rows; row += 1) {
      for (let col = 0; col < grid.cols; col += 1) {
        if (grid.blocked[row * grid.cols + col]) continue
        const c = { x: (col + 0.5) * CELL, y: (row + 0.5) * CELL }
        for (const solid of solidsOf(map)) {
          const dx = Math.max(solid.x - c.x, 0, c.x - (solid.x + solid.w))
          const dy = Math.max(solid.y - c.y, 0, c.y - (solid.y + solid.d))
          expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(WALKER_RADIUS - 1e-9)
        }
      }
    }
  })

  it('has every door open', () => {
    for (const door of map.doors) {
      const across = door.axis === 'y' ? { x: 0.7, y: 0 } : { x: 0, y: 0.7 }
      for (const point of [
        door.middle,
        { x: door.middle.x - across.x, y: door.middle.y - across.y },
        { x: door.middle.x + across.x, y: door.middle.y + across.y },
      ]) {
        expect(isFreePoint(grid, point), JSON.stringify(point)).toBe(true)
      }
    }
  })

  it('lets everyone get everywhere: every place, every door and every seat is on one connected floor', () => {
    const main = reachableFrom(grid, (map.places[0] as { stand: Point2 }).stand)
    const onMain = (p: Point2): boolean => {
      const cell = cellOf(p)
      return main.has(cell.row * grid.cols + cell.col)
    }
    for (const place of map.places) {
      for (const slot of place.slots)
        expect(onMain(slot), `${place.id} at ${JSON.stringify(slot)}`).toBe(true)
    }
    for (const door of map.doors) expect(onMain(door.middle)).toBe(true)
    for (const desk of map.desks) {
      const exit = seatExit(grid, desk, main)
      expect(exit, `a way out of the desk at ${desk.x},${desk.y}`).not.toBeNull()
      expect(onMain(exit as Point2)).toBe(true)
    }
  })

  it('has a way, clear all along, between every place and every other', () => {
    for (const a of map.places) {
      for (const b of map.places) {
        if (a === b) continue
        const path = findPath(grid, a.stand, b.stand)
        expect(path, `${a.id} to ${b.id}`).not.toBeNull()
        for (const point of along(path as Point2[])) expect(isFreePoint(grid, point)).toBe(true)
      }
    }
  })
})

describe('the edge of the floor', () => {
  it('keeps a wider walker further from it: the whole body has to be on the floor', () => {
    const map = buildOffice()
    const normal = buildNavGrid(map)
    const wide = buildNavGrid(map, 0.3)
    // The cell along the far wall is free for a normal walker and not for a wide one.
    const beside = { x: 0.25, y: 3.25 }
    expect(isFreePoint(normal, beside)).toBe(true)
    expect(isFreePoint(wide, beside)).toBe(false)
  })
})

describe('getting out of a seat', () => {
  const map = buildOffice()
  const grid = buildNavGrid(map)

  it('steps out level with the seat, past the side of the desk, on to open floor', () => {
    for (const desk of map.desks) {
      const exit = seatExit(grid, desk) as Point2
      const seat = seatPoint(desk)
      expect(exit.y).toBeCloseTo(seat.y) // level with the seat
      const station = stationRect(desk)
      expect(exit.x < station.x || exit.x > station.x + station.w).toBe(true) // past a side
      expect(isFreePoint(grid, exit)).toBe(true)
    }
  })

  it('needs a way that leads somewhere: a side that only reaches a closed-off pocket is not taken', () => {
    const desk = map.desks[0] as (typeof map.desks)[number]
    const nowhere = new Set<number>() // no floor is "the main floor"
    expect(seatExit(grid, desk, nowhere)).toBeNull()
  })

  // A desk in the middle of a row, with open floor either side and an aisle behind it.
  const middle = map.desks[6] as (typeof map.desks)[number]
  const seat = seatPoint(middle)
  const block = (g: NavGrid, x: number): void => {
    const { col, row } = cellOf({ x, y: seat.y })
    g.blocked[row * g.cols + col] = 1
  }

  it('does not step out through something in the way: it goes out the other side instead', () => {
    const walled: NavGrid = { ...grid, blocked: grid.blocked.slice() }
    // A wall across the way to the left, just past where the desk's own floor ends.
    block(walled, middle.x - 0.7)
    const exit = seatExit(walled, middle) as Point2
    expect(exit.x).toBeGreaterThan(middle.x + 1.8) // out the right, not through the wall on the left
    expect(exit.y).toBeCloseTo(seat.y)
    // Without the wall, it goes out to the left.
    expect((seatExit(grid, middle) as Point2).x).toBeLessThan(middle.x)
  })

  it('goes out behind the desk when both sides are closed off', () => {
    const boxed: NavGrid = { ...grid, blocked: grid.blocked.slice() }
    for (const reach of [0.35, 0.6, 0.85, 1.1]) {
      block(boxed, middle.x - reach)
      block(boxed, middle.x + 1.8 + reach)
    }
    const exit = seatExit(boxed, middle) as Point2
    expect(exit.y).toBeLessThan(middle.y)
    expect(exit.x).toBeCloseTo(seat.x)
  })

  it('gives nothing if every side is closed', () => {
    const closed: NavGrid = { ...grid, blocked: new Uint8Array(grid.blocked.length).fill(1) }
    expect(seatExit(closed, map.desks[0] as (typeof map.desks)[number])).toBeNull()
  })
})
