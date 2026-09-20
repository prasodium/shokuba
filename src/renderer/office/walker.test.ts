import { describe, expect, it } from 'vitest'
import { buildOffice, seatPoint, type DeskSlot, type Point2 } from './map'
import { buildNavGrid, isFreePoint, pathLength, seatExit } from './nav'
import {
  STRIDE,
  WALK_SPEED,
  advance,
  depthOfWalker,
  facingOf,
  gaitPhase,
  pathHome,
  pathTo,
  seatedAt,
  standingAt,
  startWalk,
  type Walker,
} from './walker'

const seat: Point2 = { x: 2, y: 1.5 }
const line: Point2[] = [seat, { x: 5, y: 1.5 }]
const run = (walker: Walker, seconds: number, step = 1 / 60): Walker => {
  let w = walker
  for (let t = 0; t < seconds - 1e-9; t += step) w = advance(w, step)
  return w
}

describe('a person sitting or standing', () => {
  it('stays where they are, however long it is', () => {
    const sitting = seatedAt(seat)
    expect(advance(sitting, 10)).toBe(sitting)
    const standing = standingAt({ x: 3, y: 3 }, 2)
    expect(advance(standing, 10)).toBe(standing)
  })

  it('a seated person faces the way a seated person is drawn', () => {
    expect(seatedAt(seat).facing).toBe(0)
  })
})

describe('walking', () => {
  it('goes at walking pace, along the path', () => {
    let w = startWalk(seatedAt(seat), line, { kind: 'stand', facing: 2 })
    expect(w.mode).toBe('walking')
    w = run(w, 1)
    expect(w.x).toBeCloseTo(seat.x + WALK_SPEED, 2)
    expect(w.y).toBeCloseTo(1.5)
    expect(w.mode).toBe('walking')
  })

  it('stops where the path ends however much time there is, and does what it was for', () => {
    const w = advance(startWalk(seatedAt(seat), line, { kind: 'stand', facing: 2 }), 60)
    expect(w).toMatchObject({ x: 5, y: 1.5, mode: 'standing', facing: 2, path: [], arrival: null })
  })

  it('sits down on arrival, facing the way a seated person does', () => {
    const start = standingAt({ x: 1, y: 1 }, 1)
    const w = advance(startWalk(start, [{ x: 1, y: 1 }, seat], { kind: 'sit' }), 60)
    expect(w).toMatchObject({ x: seat.x, y: seat.y, mode: 'seated', facing: 0 })
  })

  it('follows every corner of a path, and covers exactly its length', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 4 },
      { x: 0, y: 4 },
    ]
    const w = advance(
      startWalk(standingAt({ x: 0, y: 0 }, 0), path, { kind: 'stand', facing: 0 }),
      60,
    )
    expect(w).toMatchObject({ x: 0, y: 4, mode: 'standing' })
    expect(w.gait).toBeCloseTo(pathLength(path))
  })

  it('takes the same time in big steps or small', () => {
    const start = startWalk(seatedAt(seat), [seat, { x: 5, y: 1.5 }, { x: 5, y: 4 }], {
      kind: 'stand',
      facing: 0,
    })
    const small = run(start, 1.5, 1 / 120)
    const big = advance(advance(start, 0.75), 0.75)
    expect(big.x).toBeCloseTo(small.x, 2)
    expect(big.y).toBeCloseTo(small.y, 2)
  })

  it('does nothing when no time passes, or time runs backwards', () => {
    const w = startWalk(seatedAt(seat), line, { kind: 'stand', facing: 0 })
    expect(advance(w, 0)).toBe(w)
    expect(advance(w, -1)).toBe(w)
  })

  it('arrives at once if there was nowhere to go', () => {
    expect(startWalk(seatedAt(seat), [seat], { kind: 'stand', facing: 3 })).toMatchObject({
      mode: 'standing',
      facing: 3,
    })
    expect(startWalk(standingAt(seat, 0), [seat], { kind: 'sit' }).mode).toBe('seated')
  })

  it('does not change the walker it is given, even when they get all the way there', () => {
    const w = startWalk(seatedAt(seat), [seat, { x: 4, y: 1.5 }, { x: 4, y: 3 }], {
      kind: 'stand',
      facing: 0,
    })
    const before = JSON.stringify(w)
    advance(w, 1)
    advance(w, 60)
    expect(JSON.stringify(w)).toBe(before)
  })

  it('can be sent somewhere else part-way, and carries on from where it had got to', () => {
    let w = run(startWalk(seatedAt(seat), line, { kind: 'stand', facing: 0 }), 1)
    const here = { x: w.x, y: w.y }
    w = startWalk(w, [here, { x: here.x, y: here.y + 2 }], { kind: 'stand', facing: 0 })
    w = advance(w, 60)
    expect(w).toMatchObject({ x: here.x, y: here.y + 2, mode: 'standing' })
  })
})

describe('which way a person faces', () => {
  it('is along the way they are going', () => {
    expect(facingOf(0, 1, 2)).toBe(0)
    expect(facingOf(1, 0, 0)).toBe(1)
    expect(facingOf(0, -1, 0)).toBe(2)
    expect(facingOf(-1, 0, 0)).toBe(3)
    expect(facingOf(3, 1, 0)).toBe(1)
    expect(facingOf(-1, 3, 1)).toBe(0)
  })

  it('does not flicker on an exact diagonal, and does not turn for no movement', () => {
    expect(facingOf(1, 1, 3)).toBe(3)
    expect(facingOf(-2, 2, 1)).toBe(1)
    expect(facingOf(0, 0, 2)).toBe(2)
  })

  it('turns while walking a path with a corner', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
    ]
    let w = startWalk(standingAt({ x: 0, y: 0 }, 0), path, { kind: 'stand', facing: 0 })
    w = advance(w, 0.5)
    expect(w.facing).toBe(1)
    w = advance(w, 1.5)
    expect(w.facing).toBe(0)
  })
})

const start2 = (): Walker =>
  startWalk(
    standingAt({ x: 0, y: 0 }, 0),
    [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
    ],
    { kind: 'stand', facing: 1 },
  )

describe('the swing of the legs', () => {
  it('goes round once for each stride walked, and stays still when not walking', () => {
    const start = startWalk(
      standingAt({ x: 0, y: 0 }, 0),
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      { kind: 'stand', facing: 1 },
    )
    expect(gaitPhase(start)).toBe(0)
    const walked = advance(start, STRIDE / 2 / WALK_SPEED)
    expect(gaitPhase(walked)).toBeCloseTo(0.5, 5)
    const full = advance(start, STRIDE / WALK_SPEED)
    expect(gaitPhase(full)).toBeCloseTo(0, 5)
    expect(gaitPhase(seatedAt(seat))).toBe(0)
    expect(gaitPhase(standingAt(seat, 0))).toBe(0)
  })

  it('stops when they stop: someone who has walked and arrived stands still', () => {
    const arrived = advance(start2(), 60)
    expect(arrived.mode).toBe('standing')
    expect(arrived.gait).toBeGreaterThan(1) // they did walk
    expect(gaitPhase(arrived)).toBe(0)
  })

  it('is about a stride a person could take, and a pace about that of a brisk walk', () => {
    expect(STRIDE).toBeGreaterThan(0.5)
    expect(STRIDE).toBeLessThan(1.5)
    expect(WALK_SPEED).toBeGreaterThan(1)
    expect(WALK_SPEED).toBeLessThan(2.5)
  })
})

describe('depth', () => {
  it('is nearer the camera the further they are toward +x and +y', () => {
    expect(depthOfWalker(standingAt({ x: 5, y: 5 }, 0))).toBeGreaterThan(
      depthOfWalker(standingAt({ x: 2, y: 3 }, 0)),
    )
  })
})

describe('the way from a desk to a place and back, on the real floor', () => {
  const map = buildOffice()
  const grid = buildNavGrid(map)
  const desk = map.desks[3] as (typeof map.desks)[number]
  const home = { seat: seatPoint(desk), exit: seatExit(grid, desk) as Point2 }
  const bench = map.places.find((p) => p.id === 'qa')?.slots[0] as Point2

  it('steps out of the seat first, then walks on free floor to the place', () => {
    const path = pathTo(grid, seatedAt(home.seat), home, bench) as Point2[]
    expect(path[0]).toEqual(home.seat)
    expect(path[1]).toEqual(home.exit)
    expect(path.at(-1)).toEqual(bench)
    for (const point of path.slice(1, -1)) expect(isFreePoint(grid, point)).toBe(true)
  })

  it('starts from where a standing person is, without going near the seat', () => {
    const here = { x: 6.25, y: 6.25 }
    const path = pathTo(grid, standingAt(here, 0), home, bench) as Point2[]
    expect(path[0]).toEqual(here)
    expect(path).not.toContainEqual(home.seat)
  })

  it('comes home by the exit and sits down', () => {
    const away = standingAt(bench, 2)
    const path = pathHome(grid, away, home) as Point2[]
    expect(path[0]).toEqual(bench)
    expect(path.at(-1)).toEqual(home.seat)
    expect(path.at(-2)).toEqual(home.exit)
    const arrived = advance(startWalk(away, path, { kind: 'sit' }), 600)
    expect(arrived).toMatchObject({ x: home.seat.x, y: home.seat.y, mode: 'seated' })
  })

  describe('from a reading desk', () => {
    const station = map.places.find((p) => p.id === 'reading-1')?.station as DeskSlot
    const chair = { seat: seatPoint(station), exit: seatExit(grid, station) as Point2 }

    it('steps out of that chair first, then walks home and sits at its own desk', () => {
      const path = pathHome(grid, seatedAt(chair.seat), home, chair) as Point2[]
      expect(path.slice(0, 2)).toEqual([chair.seat, chair.exit])
      expect(path.at(-2)).toEqual(home.exit)
      expect(path.at(-1)).toEqual(home.seat)
      for (const point of path.slice(1, -1)) expect(isFreePoint(grid, point)).toBe(true)
      const arrived = advance(startWalk(seatedAt(chair.seat), path, { kind: 'sit' }), 600)
      expect(arrived).toMatchObject({ x: home.seat.x, y: home.seat.y, mode: 'seated' })
    })

    it('goes on to a place from that chair the same way', () => {
      const path = pathTo(grid, seatedAt(chair.seat), chair, bench) as Point2[]
      expect(path.slice(0, 2)).toEqual([chair.seat, chair.exit])
      expect(path.at(-1)).toEqual(bench)
    })

    it('does not use the chair when they are standing, only where they are', () => {
      const away = standingAt(bench, 2)
      expect(pathHome(grid, away, home, chair)).toEqual(pathHome(grid, away, home))
    })
  })

  it('takes a sensible time: a few seconds across the office, not minutes', () => {
    const path = pathTo(grid, seatedAt(home.seat), home, bench) as Point2[]
    const seconds = pathLength(path) / WALK_SPEED
    expect(seconds).toBeGreaterThan(1)
    expect(seconds).toBeLessThan(20)
  })

  it('says so when there is no way', () => {
    const shut = { ...grid, blocked: new Uint8Array(grid.blocked.length).fill(1) }
    expect(pathTo(shut, seatedAt(home.seat), home, bench)).toBeNull()
    expect(pathHome(shut, standingAt(bench, 0), home)).toBeNull()
  })
})
