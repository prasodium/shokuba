import { describe, expect, it } from 'vitest'
import {
  boxFaces,
  fitToViewport,
  hexToNumber,
  project,
  rectBounds,
  roomBounds,
  shade,
  sortByDepth,
  tilePolygon,
  unionBounds,
  TILE_H,
  TILE_W,
  Z_UNIT,
} from './iso'

describe('project', () => {
  it('puts the origin at the top of the diamond', () => {
    expect(project(0, 0)).toEqual({ x: 0, y: 0 })
  })

  it('moves +x to the lower right and +y to the lower left', () => {
    expect(project(1, 0)).toEqual({ x: TILE_W / 2, y: TILE_H / 2 })
    expect(project(0, 1)).toEqual({ x: -TILE_W / 2, y: TILE_H / 2 })
  })

  it('moves up the screen with height', () => {
    expect(project(0, 0, 2)).toEqual({ x: 0, y: -2 * Z_UNIT })
  })

  it('makes nearer things (larger x + y) lower on screen', () => {
    expect(project(3, 3).y).toBeGreaterThan(project(1, 1).y)
  })
})

describe('shade', () => {
  it('scales channels and clamps', () => {
    expect(shade(0x808080, 0.5)).toBe(0x404040)
    expect(shade(0xf0f0f0, 2)).toBe(0xffffff)
    expect(shade(0x123456, 0)).toBe(0)
  })
})

describe('hexToNumber', () => {
  it('parses #rrggbb', () => {
    expect(hexToNumber('#e8893a')).toBe(0xe8893a)
  })
})

describe('boxFaces', () => {
  it('produces three quads of four points each', () => {
    const faces = boxFaces({ x: 0, y: 0, z: 0, w: 1, d: 1, h: 1, color: 0 })
    expect(faces.top).toHaveLength(8)
    expect(faces.left).toHaveLength(8)
    expect(faces.right).toHaveLength(8)
  })

  it('draws the top at the box height and the sides down to its base', () => {
    const { top, left } = boxFaces({ x: 0, y: 0, z: 1, w: 1, d: 1, h: 2, color: 0 })
    // First top point is (0,0,3): straight up from the origin by 3 units.
    expect(top.slice(0, 2)).toEqual([0, -3 * Z_UNIT])
    // The left face's bottom edge sits at the base height z = 1.
    expect(left[5]).toBe(project(1, 1, 1).y)
  })

  it('has a top face that is a diamond of the box footprint', () => {
    const { top } = boxFaces({ x: 2, y: 3, z: 0, w: 1, d: 1, h: 0, color: 0 })
    expect(top).toEqual(tilePolygon(2, 3))
  })
})

describe('sortByDepth', () => {
  it('orders farthest (smallest x + y) first', () => {
    const boxes = [
      { x: 4, y: 4, z: 0, w: 1, d: 1 },
      { x: 0, y: 0, z: 0, w: 1, d: 1 },
      { x: 2, y: 2, z: 0, w: 1, d: 1 },
    ]
    expect(sortByDepth(boxes).map((b) => b.x)).toEqual([0, 2, 4])
  })

  it('draws a taller item after a lower one in the same spot', () => {
    const boxes = [
      { x: 1, y: 1, z: 1, w: 1, d: 1 },
      { x: 1, y: 1, z: 0, w: 1, d: 1 },
    ]
    expect(sortByDepth(boxes).map((b) => b.z)).toEqual([0, 1])
  })

  it('does not mutate its input', () => {
    const boxes = [
      { x: 2, y: 2, z: 0, w: 1, d: 1 },
      { x: 0, y: 0, z: 0, w: 1, d: 1 },
    ]
    sortByDepth(boxes)
    expect(boxes[0]?.x).toBe(2)
  })
})

describe('fitToViewport', () => {
  const bounds = roomBounds(8, 8, 2.8)

  it('scales the room to fit and centres it', () => {
    const viewport = { width: 800, height: 500 }
    const { scale, offsetX, offsetY } = fitToViewport(bounds, viewport, 20)
    const w = (bounds.maxX - bounds.minX) * scale
    const h = (bounds.maxY - bounds.minY) * scale
    expect(w).toBeLessThanOrEqual(800 - 40 + 0.001)
    expect(h).toBeLessThanOrEqual(500 - 40 + 0.001)
    expect(bounds.minX * scale + offsetX + w / 2).toBeCloseTo(400)
    expect(bounds.minY * scale + offsetY + h / 2).toBeCloseTo(250)
  })

  it('never returns a non-positive scale for a tiny viewport', () => {
    expect(fitToViewport(bounds, { width: 10, height: 10 }).scale).toBeGreaterThan(0)
  })
})

describe('rectBounds and unionBounds', () => {
  it('holds every corner of a floor rectangle, from its slab up to the height given', () => {
    const rect = { x: 8, y: 0, w: 8, d: 7 }
    const b = rectBounds(rect, 2.8)
    for (const [x, y, z] of [
      [8, 0, 2.8],
      [16, 0, 2.8],
      [8, 7, -0.3],
      [16, 7, -0.3],
      [16, 0, 0],
    ] as const) {
      const p = project(x, y, z)
      expect(p.x).toBeGreaterThanOrEqual(b.minX - 1e-9)
      expect(p.x).toBeLessThanOrEqual(b.maxX + 1e-9)
      expect(p.y).toBeGreaterThanOrEqual(b.minY - 1e-9)
      expect(p.y).toBeLessThanOrEqual(b.maxY + 1e-9)
    }
  })

  it('agrees with a room at the origin about how wide and tall it is', () => {
    const a = roomBounds(8, 7, 2.8)
    const b = rectBounds({ x: 0, y: 0, w: 8, d: 7 }, 2.8)
    expect(b.minX).toBeCloseTo(a.minX)
    expect(b.maxX).toBeCloseTo(a.maxX)
    expect(b.minY).toBeCloseTo(a.minY)
  })

  it('joins bounds into the smallest that holds them all, whichever one each edge comes from', () => {
    const joined = unionBounds([
      { minX: -9, maxX: 1, minY: 0, maxY: 50 },
      { minX: 0, maxX: 10, minY: -5, maxY: 20 },
      { minX: 2, maxX: 3, minY: 8, maxY: 30 },
    ])
    expect(joined).toEqual({ minX: -9, maxX: 10, minY: -5, maxY: 50 })
    // Order does not matter.
    const [a, b, c] = [
      { minX: -9, maxX: 1, minY: 0, maxY: 50 },
      { minX: 0, maxX: 10, minY: -5, maxY: 20 },
      { minX: 2, maxX: 3, minY: 8, maxY: 30 },
    ]
    expect(unionBounds([c, b, a])).toEqual(joined)
  })

  it('covers an L-shaped office more tightly than its bounding rectangle', () => {
    const l = unionBounds([
      rectBounds({ x: 0, y: 0, w: 8, d: 7 }, 2.8),
      rectBounds({ x: 8, y: 0, w: 8, d: 7 }, 2.8),
      rectBounds({ x: 0, y: 7, w: 8, d: 7 }, 2.8),
    ])
    const box = rectBounds({ x: 0, y: 0, w: 16, d: 14 }, 2.8)
    // The empty corner is the nearest one, so the L is shorter on screen but as wide.
    expect(l.maxY).toBeLessThan(box.maxY)
    expect(l.minX).toBeCloseTo(box.minX)
    expect(l.maxX).toBeCloseTo(box.maxX)
  })
})
