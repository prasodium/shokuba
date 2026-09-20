import { findPath, type NavGrid } from './nav'
import type { Point2 } from './map'

/**
 * One person moving about the office, as plain data and pure steps, so movement can be tested on a
 * fake clock. The scene draws what this says and decides nothing itself.
 */

/** How fast people walk, in tiles a second: about five seconds to cross a room. */
export const WALK_SPEED = 1.6
/** How far a person walks in one full cycle of the legs. */
export const STRIDE = 0.9

/** Which way a person faces: 0 toward +y, 1 toward +x, 2 toward -y, 3 toward -x. */
export type Facing = 0 | 1 | 2 | 3

export type Arrival = { kind: 'sit' } | { kind: 'stand'; facing: Facing }

export interface Walker {
  x: number
  y: number
  mode: 'seated' | 'walking' | 'standing'
  facing: Facing
  /** Points still to walk to, nearest first. Empty unless walking. */
  path: Point2[]
  /** What they do on getting there. */
  arrival: Arrival | null
  /** Distance walked so far, for the swing of the legs. */
  gait: number
}

/** A person sitting at a desk, looking toward +y as every seated person does. */
export function seatedAt(seat: Point2): Walker {
  return { x: seat.x, y: seat.y, mode: 'seated', facing: 0, path: [], arrival: null, gait: 0 }
}

/** A person standing at a point. */
export function standingAt(point: Point2, facing: Facing): Walker {
  return { x: point.x, y: point.y, mode: 'standing', facing, path: [], arrival: null, gait: 0 }
}

/**
 * Which way to face for a movement of (`dx`, `dy`): along whichever axis it is mostly along. A
 * movement that is exactly diagonal keeps the way already faced, so nobody flickers between two.
 */
export function facingOf(dx: number, dy: number, current: Facing): Facing {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax < 1e-9 && ay < 1e-9) return current
  if (Math.abs(ax - ay) < 1e-9) return current
  if (ax > ay) return dx > 0 ? 1 : 3
  return dy > 0 ? 0 : 2
}

/** Start walking along `path`, from wherever they are now. The path's first point is where they are. */
export function startWalk(walker: Walker, path: readonly Point2[], arrival: Arrival): Walker {
  const rest = path.slice(1)
  if (rest.length === 0) return arrive({ ...walker, path: [], arrival }, arrival)
  return { ...walker, mode: 'walking', path: rest, arrival }
}

function arrive(walker: Walker, arrival: Arrival | null): Walker {
  if (arrival?.kind === 'sit')
    return { ...walker, mode: 'seated', facing: 0, path: [], arrival: null }
  return {
    ...walker,
    mode: 'standing',
    facing: arrival?.kind === 'stand' ? arrival.facing : walker.facing,
    path: [],
    arrival: null,
  }
}

/** Move a walker on by `dt` seconds. Time never carries past arriving: they stop where the path ends. */
export function advance(walker: Walker, dt: number, speed = WALK_SPEED): Walker {
  if (walker.mode !== 'walking' || dt <= 0) return walker
  let { x, y, facing, gait } = walker
  let left = speed * dt
  const path = [...walker.path]
  while (path.length > 0 && left > 1e-12) {
    const next = path[0] as Point2
    const dx = next.x - x
    const dy = next.y - y
    const distance = Math.hypot(dx, dy)
    if (distance > 1e-12) facing = facingOf(dx, dy, facing)
    if (distance <= left) {
      x = next.x
      y = next.y
      left -= distance
      gait += distance
      path.shift()
    } else {
      x += (dx / distance) * left
      y += (dy / distance) * left
      gait += left
      left = 0
    }
  }
  const moved: Walker = { ...walker, x, y, facing, gait, path }
  return path.length === 0 ? arrive(moved, walker.arrival) : moved
}

/** Where a person sits, and where they step out to when they stand. */
export interface Home {
  seat: Point2
  exit: Point2
}

/**
 * The way for `walker` to reach `target`. From a seat it starts by stepping out to the exit;
 * from anywhere else it starts where they are. Null if there is no way.
 */
export function pathTo(grid: NavGrid, walker: Walker, home: Home, target: Point2): Point2[] | null {
  const lead: Point2[] =
    walker.mode === 'seated' ? [home.seat, home.exit] : [{ x: walker.x, y: walker.y }]
  const rest = findPath(grid, lead[lead.length - 1] as Point2, target)
  return rest ? [...lead, ...rest.slice(1)] : null
}

/**
 * The way for `walker` back to their seat, ending with sitting down. `chair` is the seat they are
 * in, if it is not their own (a reading desk): they step out of it first. Null if there is no way.
 */
export function pathHome(
  grid: NavGrid,
  walker: Walker,
  home: Home,
  chair: Home = home,
): Point2[] | null {
  const lead: Point2[] =
    walker.mode === 'seated' ? [chair.seat, chair.exit] : [{ x: walker.x, y: walker.y }]
  const rest = findPath(grid, lead[lead.length - 1] as Point2, home.exit)
  return rest ? [...lead, ...rest.slice(1), home.seat] : null
}

/** How far through a leg swing they are, 0 to 1, for drawing legs and arms. */
export function gaitPhase(walker: Walker): number {
  if (walker.mode !== 'walking') return 0
  return (walker.gait / STRIDE) % 1
}

/** How near a walker is to the camera, for putting them in order among everything else. */
export function depthOfWalker(walker: Walker): number {
  return walker.x + walker.y
}
