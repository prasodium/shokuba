/**
 * Isometric projection for the voxel office. Pure geometry, no rendering, so it can be
 * tested. Grid axes: x grows toward the lower-right of the screen, y toward the lower-left,
 * z is height. The camera looks from the (+x, +y) side, so larger x + y is nearer.
 */

export const TILE_W = 64
export const TILE_H = 32
/** Pixels per unit of height. */
export const Z_UNIT = 30

export interface Point {
  x: number
  y: number
}

export function project(x: number, y: number, z = 0): Point {
  return { x: ((x - y) * TILE_W) / 2, y: ((x + y) * TILE_H) / 2 - z * Z_UNIT }
}

/** Multiply an 0xRRGGBB colour's channels by `factor` (<1 darkens, >1 lightens), clamped. */
export function shade(color: number, factor: number): number {
  const channel = (shift: number): number =>
    Math.max(0, Math.min(255, Math.round(((color >> shift) & 0xff) * factor)))
  return (channel(16) << 16) | (channel(8) << 8) | channel(0)
}

export function hexToNumber(hex: string): number {
  return Number.parseInt(hex.replace('#', ''), 16)
}

/** An axis-aligned box: `w` along x, `d` along y, `h` along z, with its low corner at (x, y, z). */
export interface Box {
  x: number
  y: number
  z: number
  w: number
  d: number
  h: number
  color: number
  /** How solid it is, 0 to 1; left out means fully solid. Glass is see-through. */
  alpha?: number
}

/** Flat `[x0, y0, x1, y1, ...]` polygons for the three faces a camera at (+x, +y, +z) can see. */
export interface BoxFaces {
  top: number[]
  /** The face looking toward +y (appears on the left of the box on screen). */
  left: number[]
  /** The face looking toward +x (appears on the right). */
  right: number[]
}

function flat(points: Point[]): number[] {
  return points.flatMap((p) => [p.x, p.y])
}

export function boxFaces(box: Box): BoxFaces {
  const { x, y, z, w, d, h } = box
  const x1 = x + w
  const y1 = y + d
  const z1 = z + h
  return {
    top: flat([project(x, y, z1), project(x1, y, z1), project(x1, y1, z1), project(x, y1, z1)]),
    left: flat([project(x, y1, z1), project(x1, y1, z1), project(x1, y1, z), project(x, y1, z)]),
    right: flat([project(x1, y, z1), project(x1, y1, z1), project(x1, y1, z), project(x1, y, z)]),
  }
}

/** The diamond a floor tile occupies. */
export function tilePolygon(x: number, y: number, w = 1, d = 1, z = 0): number[] {
  return flat([
    project(x, y, z),
    project(x + w, y, z),
    project(x + w, y + d, z),
    project(x, y + d, z),
  ])
}

/** Painter's order: farthest first. Boxes must not interpenetrate for this to be exact. */
export function sortByDepth<T extends { x: number; y: number; z: number; w: number; d: number }>(
  items: readonly T[],
): T[] {
  const key = (item: T): number => item.x + item.w / 2 + item.y + item.d / 2 + item.z * 0.01
  return [...items].sort((a, b) => key(a) - key(b))
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Screen-space bounds of a room `width` by `depth` tiles with walls `wallHeight` tall. */
export function roomBounds(width: number, depth: number, wallHeight: number): Bounds {
  const corners = [
    project(0, 0, wallHeight),
    project(width, 0, wallHeight),
    project(0, depth, wallHeight),
    project(width, depth, 0),
    project(0, depth, 0),
    project(width, 0, 0),
  ]
  return {
    minX: Math.min(...corners.map((p) => p.x)),
    maxX: Math.max(...corners.map((p) => p.x)),
    minY: Math.min(...corners.map((p) => p.y)),
    maxY: Math.max(...corners.map((p) => p.y)),
  }
}

/** Screen-space bounds of a floor rectangle, from its slab below the floor up to `height`. */
export function rectBounds(
  rect: { x: number; y: number; w: number; d: number },
  height: number,
  slab = 0.3,
): Bounds {
  const corners: Point[] = []
  for (const z of [-slab, height]) {
    for (const x of [rect.x, rect.x + rect.w]) {
      for (const y of [rect.y, rect.y + rect.d]) corners.push(project(x, y, z))
    }
  }
  return {
    minX: Math.min(...corners.map((p) => p.x)),
    maxX: Math.max(...corners.map((p) => p.x)),
    minY: Math.min(...corners.map((p) => p.y)),
    maxY: Math.max(...corners.map((p) => p.y)),
  }
}

/** The smallest bounds that hold all of `list` (which must not be empty). */
export function unionBounds(list: readonly Bounds[]): Bounds {
  return {
    minX: Math.min(...list.map((b) => b.minX)),
    maxX: Math.max(...list.map((b) => b.maxX)),
    minY: Math.min(...list.map((b) => b.minY)),
    maxY: Math.max(...list.map((b) => b.maxY)),
  }
}

/** Scale and offset that centre `bounds` inside a viewport, with a margin. */
export function fitToViewport(
  bounds: Bounds,
  viewport: { width: number; height: number },
  margin = 24,
): { scale: number; offsetX: number; offsetY: number } {
  const w = bounds.maxX - bounds.minX
  const h = bounds.maxY - bounds.minY
  const scale = Math.max(
    0.1,
    Math.min((viewport.width - margin * 2) / w, (viewport.height - margin * 2) / h),
  )
  return {
    scale,
    offsetX: viewport.width / 2 - ((bounds.minX + bounds.maxX) / 2) * scale,
    offsetY: viewport.height / 2 - ((bounds.minY + bounds.maxY) / 2) * scale,
  }
}
