import { describe, expect, it } from 'vitest'
import {
  ACCESSORIES,
  DEFAULT_APPEARANCE,
  HAIR_STYLES,
  hairColor,
  skinColor,
} from '@shared/appearance'
import { chairBoxes, personBoxes } from './furniture'
import { shade } from './iso'
import { fitPreview, polygonsOf, previewOf } from './preview'
import { poseFor } from './pose'

const shirt = 0x336699

describe('previewOf', () => {
  it('is three polygons for each box of the chair and the person, in painting order', () => {
    const boxes = [...chairBoxes(), ...personBoxes(poseFor('idle', 0), shirt, DEFAULT_APPEARANCE)]
    const preview = previewOf(DEFAULT_APPEARANCE, shirt)
    expect(preview.polygons).toHaveLength(boxes.length * 3)
    // The chair is painted first, then the person.
    expect(preview.polygons[0]?.color).toBe(shade(chairBoxes()[0]?.color ?? 0, 0.82))
  })

  it('shows the skin, the hair and the shirt the person was given', () => {
    const look = { skin: 'umber', hair: 'blue', style: 'short', accessory: 'none' } as const
    const colors = new Set(previewOf(look, shirt).polygons.map((p) => p.color))
    expect(colors.has(skinColor('umber'))).toBe(true)
    expect(colors.has(hairColor('blue'))).toBe(true)
    expect(colors.has(shirt)).toBe(true)
    expect(colors.has(skinColor('sand'))).toBe(false)
  })

  it('changes with every style and accessory, so the form shows what was chosen', () => {
    const seen = new Set<string>()
    for (const style of HAIR_STYLES) {
      for (const accessory of ACCESSORIES) {
        const look = { ...DEFAULT_APPEARANCE, style: style.id, accessory: accessory.id }
        seen.add(JSON.stringify(previewOf(look, shirt).polygons))
      }
    }
    // A bun under a cap cannot be seen, so one pair is the same picture.
    expect(seen.size).toBe(HAIR_STYLES.length * ACCESSORIES.length - 1)
  })

  it('has real, finite bounds round everything drawn', () => {
    const { polygons, bounds } = previewOf(DEFAULT_APPEARANCE, shirt)
    for (const value of Object.values(bounds)) expect(Number.isFinite(value)).toBe(true)
    expect(bounds.maxX).toBeGreaterThan(bounds.minX)
    expect(bounds.maxY).toBeGreaterThan(bounds.minY)
    for (const polygon of polygons) {
      for (let i = 0; i < polygon.points.length; i += 2) {
        expect(polygon.points[i] as number).toBeGreaterThanOrEqual(bounds.minX)
        expect(polygon.points[i] as number).toBeLessThanOrEqual(bounds.maxX)
        expect(polygon.points[i + 1] as number).toBeGreaterThanOrEqual(bounds.minY)
        expect(polygon.points[i + 1] as number).toBeLessThanOrEqual(bounds.maxY)
      }
    }
  })

  it('keeps the glass of glasses see-through', () => {
    const glasses = previewOf({ ...DEFAULT_APPEARANCE, accessory: 'glasses' }, shirt)
    expect(glasses.polygons.some((p) => p.alpha < 1)).toBe(true)
    expect(previewOf(DEFAULT_APPEARANCE, shirt).polygons.every((p) => p.alpha === 1)).toBe(true)
  })
})

describe('polygonsOf', () => {
  it('shades a box’s left side lighter than its right, and leaves the top as it is', () => {
    const [left, right, top] = polygonsOf([{ x: 0, y: 0, z: 0, w: 1, d: 1, h: 1, color: 0x808080 }])
    expect(top?.color).toBe(0x808080)
    expect(left?.color).toBe(shade(0x808080, 0.82))
    expect(right?.color).toBe(shade(0x808080, 0.66))
    expect((left?.color ?? 0) > (right?.color ?? 0)).toBe(true)
  })

  it('is nothing for nothing', () => {
    expect(polygonsOf([])).toEqual([])
  })
})

describe('fitPreview', () => {
  const bounds = { minX: -10, minY: -40, maxX: 30, maxY: 20 }

  it('keeps the picture whole inside the space, with room to spare, never stretching it', () => {
    for (const [width, height] of [
      [200, 200],
      [100, 300],
      [400, 80],
    ] as const) {
      const fit = fitPreview(bounds, width, height, 6)
      const left = bounds.minX * fit.scale + fit.x
      const right = bounds.maxX * fit.scale + fit.x
      const top = bounds.minY * fit.scale + fit.y
      const bottom = bounds.maxY * fit.scale + fit.y
      expect(left).toBeGreaterThanOrEqual(6 - 1e-6)
      expect(right).toBeLessThanOrEqual(width - 6 + 1e-6)
      expect(top).toBeGreaterThanOrEqual(6 - 1e-6)
      expect(bottom).toBeLessThanOrEqual(height - 6 + 1e-6)
    }
  })

  it('centres the picture, and fills the space in the tighter direction', () => {
    const fit = fitPreview(bounds, 200, 200, 0)
    const left = bounds.minX * fit.scale + fit.x
    const right = bounds.maxX * fit.scale + fit.x
    expect(left + right).toBeCloseTo(200)
    // The picture is 40 wide and 60 tall, so height decides.
    expect(fit.scale).toBeCloseTo(200 / 60)
  })
})
