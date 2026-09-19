import { describe, expect, it } from 'vitest'
import {
  KEY_PAN,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
  actionForKey,
  centreOf,
  clampCamera,
  fitCamera,
  followStep,
  FOLLOW_ZOOM,
  labelScale,
  ROLE_MIN_SCALE,
  panBy,
  scaleOf,
  screenToWorld,
  transformOf,
  wheelFactor,
  zoomAt,
} from './camera'
import { fitToViewport } from './iso'

const bounds = { minX: -200, maxX: 600, minY: 0, maxY: 400 }
const viewport = { width: 1000, height: 600 }
const near = (a: number, b: number, digits = 6): void => expect(a).toBeCloseTo(b, digits)

describe('the fit', () => {
  it('shows the whole office, centred, at zoom 1', () => {
    const camera = fitCamera(bounds)
    expect(camera).toEqual({ zoom: 1, ...centreOf(bounds) })
    const t = transformOf(camera, bounds, viewport)
    const fit = fitToViewport(bounds, viewport, 28)
    near(t.scale, fit.scale)
    near(t.x, fit.offsetX)
    near(t.y, fit.offsetY)
  })

  it('keeps the office centred in the panel, whatever the panel’s shape', () => {
    for (const shape of [viewport, { width: 400, height: 900 }, { width: 1500, height: 300 }]) {
      const t = transformOf(fitCamera(bounds), bounds, shape)
      const c = centreOf(bounds)
      near(t.x + c.x * t.scale, shape.width / 2)
      near(t.y + c.y * t.scale, shape.height / 2)
    }
  })

  it('scales with the zoom, relative to the size that fits', () => {
    const fit = scaleOf(fitCamera(bounds), bounds, viewport)
    near(scaleOf({ ...fitCamera(bounds), zoom: 2 }, bounds, viewport), fit * 2)
  })
})

describe('zooming at a point', () => {
  it('keeps the point of the office under the pointer where it was', () => {
    const start = { zoom: 1.5, x: 100, y: 150 }
    for (const anchor of [
      { x: 500, y: 300 },
      { x: 120, y: 80 },
      { x: 900, y: 550 },
    ]) {
      const before = screenToWorld(anchor, start, bounds, viewport)
      const zoomed = zoomAt(start, 1.6, anchor, bounds, viewport)
      const after = screenToWorld(anchor, zoomed, bounds, viewport)
      near(after.x, before.x, 4)
      near(after.y, before.y, 4)
      expect(zoomed.zoom).toBeCloseTo(2.4)
    }
  })

  it('zooms about the centre without moving it', () => {
    const zoomed = zoomAt(fitCamera(bounds), 2, { x: 500, y: 300 }, bounds, viewport)
    near(zoomed.x, centreOf(bounds).x)
    near(zoomed.y, centreOf(bounds).y)
    expect(zoomed.zoom).toBe(2)
  })

  it('stops at the nearest and the farthest', () => {
    const start = fitCamera(bounds)
    expect(zoomAt(start, 1000, { x: 500, y: 300 }, bounds, viewport).zoom).toBe(MAX_ZOOM)
    expect(zoomAt(start, 0.0001, { x: 500, y: 300 }, bounds, viewport).zoom).toBe(MIN_ZOOM)
    const nearest = { ...start, zoom: MAX_ZOOM }
    expect(zoomAt(nearest, 2, { x: 10, y: 10 }, bounds, viewport)).toBe(nearest) // nothing changes
  })

  it('never leaves the centre outside the office', () => {
    const zoomed = zoomAt({ zoom: 1, x: 590, y: 390 }, 4, { x: 0, y: 0 }, bounds, viewport)
    expect(zoomed.x).toBeGreaterThanOrEqual(bounds.minX)
    expect(zoomed.y).toBeGreaterThanOrEqual(bounds.minY)
  })
})

describe('dragging', () => {
  it('moves the office with the pointer: dragging right shows what is to the left', () => {
    const start = { zoom: 2, x: 200, y: 200 }
    const scale = scaleOf(start, bounds, viewport)
    const moved = panBy(start, 100, -50, bounds, viewport)
    near(moved.x, 200 - 100 / scale)
    near(moved.y, 200 + 50 / scale)
    expect(moved.zoom).toBe(2)
  })

  it('cannot drag the office out of sight', () => {
    const far = panBy(fitCamera(bounds), -1e9, 1e9, bounds, viewport)
    expect(far.x).toBe(bounds.maxX)
    expect(far.y).toBe(bounds.minY)
  })

  it('clampCamera keeps zoom in range too', () => {
    expect(clampCamera({ zoom: 99, x: 0, y: 0 }, bounds).zoom).toBe(MAX_ZOOM)
    expect(clampCamera({ zoom: 0, x: 0, y: 0 }, bounds).zoom).toBe(MIN_ZOOM)
  })
})

describe('following something', () => {
  // Already closer than following would bring it, so only the centre moves.
  const start = { zoom: 3, x: 0, y: 100 }
  const target = { x: 400, y: 300 }

  it('eases toward it, a bit further each step, and never overshoots', () => {
    let camera = start
    let last = Math.abs(target.x - camera.x)
    for (let i = 0; i < 20; i += 1) {
      camera = followStep(camera, target, 1 / 60, false, bounds)
      const gap = Math.abs(target.x - camera.x)
      expect(gap).toBeLessThanOrEqual(last)
      expect(camera.x).toBeLessThanOrEqual(target.x)
      last = gap
    }
    expect(camera.x).toBeGreaterThan(start.x)
    expect(camera.x).toBeLessThan(target.x)
  })

  it('settles exactly on it, and stops', () => {
    let camera = start
    for (let i = 0; i < 600; i += 1) camera = followStep(camera, target, 1 / 60, false, bounds)
    expect(camera).toEqual({ zoom: 3, ...target })
  })

  it('jumps straight there with reduced motion', () => {
    expect(followStep(start, target, 1 / 60, true, bounds)).toEqual({ zoom: 3, ...target })
  })

  it('does not move on no time passing', () => {
    expect(followStep(start, target, 0, false, bounds)).toEqual(start)
  })

  it('brings the picture in when the whole office is showing, and settles at the follow zoom', () => {
    let camera = fitCamera(bounds)
    let last = camera.zoom
    for (let i = 0; i < 20; i += 1) {
      camera = followStep(camera, target, 1 / 60, false, bounds)
      expect(camera.zoom).toBeGreaterThanOrEqual(last) // only ever closer
      expect(camera.zoom).toBeLessThanOrEqual(FOLLOW_ZOOM)
      last = camera.zoom
    }
    expect(camera.zoom).toBeGreaterThan(1)
    for (let i = 0; i < 600; i += 1) camera = followStep(camera, target, 1 / 60, false, bounds)
    expect(camera).toEqual({ zoom: FOLLOW_ZOOM, ...target })
  })

  it('never zooms out someone who is already closer', () => {
    for (const zoom of [FOLLOW_ZOOM, 3, MAX_ZOOM]) {
      let camera = { zoom, x: 0, y: 0 }
      for (let i = 0; i < 100; i += 1) camera = followStep(camera, target, 1 / 60, false, bounds)
      expect(camera.zoom).toBe(zoom)
    }
  })

  it('goes straight to the follow zoom with reduced motion', () => {
    expect(followStep(fitCamera(bounds), target, 1 / 60, true, bounds).zoom).toBe(FOLLOW_ZOOM)
  })
})

describe('the mouse wheel', () => {
  it('zooms in when scrolled away and out when scrolled toward you, by an amount that grows with the turn', () => {
    expect(wheelFactor(-100, 0)).toBeGreaterThan(1)
    expect(wheelFactor(100, 0)).toBeLessThan(1)
    expect(wheelFactor(-200, 0)).toBeGreaterThan(wheelFactor(-100, 0))
    expect(wheelFactor(0, 0)).toBe(1)
  })

  it('treats a step forward and a step back as undoing each other', () => {
    near(wheelFactor(-100, 0) * wheelFactor(100, 0), 1)
  })

  it('reads lines and pages as more than pixels, and limits one turn so a fast wheel cannot jump', () => {
    expect(wheelFactor(-3, 1)).toBeCloseTo(wheelFactor(-48, 0))
    expect(wheelFactor(-1, 2)).toBeCloseTo(wheelFactor(-240, 0)) // a page, cut to the limit
    expect(wheelFactor(-100000, 0)).toBe(wheelFactor(-240, 0))
  })
})

describe('the keyboard', () => {
  it('pans with the arrow keys, moving the office the way the key points', () => {
    expect(actionForKey('ArrowLeft')).toEqual({ kind: 'pan', dx: KEY_PAN, dy: 0 })
    expect(actionForKey('ArrowRight')).toEqual({ kind: 'pan', dx: -KEY_PAN, dy: 0 })
    expect(actionForKey('ArrowUp')).toEqual({ kind: 'pan', dx: 0, dy: KEY_PAN })
    expect(actionForKey('ArrowDown')).toEqual({ kind: 'pan', dx: 0, dy: -KEY_PAN })
  })

  it('zooms with plus and minus, fits with 0, and follows with f', () => {
    expect(actionForKey('+')).toEqual({ kind: 'zoom', factor: ZOOM_STEP })
    expect(actionForKey('=')).toEqual({ kind: 'zoom', factor: ZOOM_STEP })
    expect(actionForKey('-')).toEqual({ kind: 'zoom', factor: 1 / ZOOM_STEP })
    expect(actionForKey('0')).toEqual({ kind: 'fit' })
    expect(actionForKey('f')).toEqual({ kind: 'follow' })
    expect(actionForKey('F')).toEqual({ kind: 'follow' })
  })

  it('leaves every other key alone, so typing elsewhere is never taken', () => {
    for (const key of ['a', 'Enter', 'Tab', ' ', 'Escape', '1'])
      expect(actionForKey(key)).toBeNull()
  })
})

describe('how big the labels are drawn', () => {
  it('are full size when the office is drawn at a normal size or larger', () => {
    expect(labelScale(1)).toBe(1)
    expect(labelScale(2.5)).toBe(1)
  })

  it('shrink with the office, so neighbours do not overlap, but never past what can be read', () => {
    expect(labelScale(0.8)).toBe(0.8)
    expect(labelScale(0.6)).toBe(0.6)
    expect(labelScale(0.2)).toBe(0.55)
    expect(labelScale(0)).toBe(0.55)
  })

  it('never get bigger as the office gets smaller', () => {
    let last = Infinity
    for (let s = 2; s >= 0.1; s -= 0.05) {
      const now = labelScale(s)
      expect(now).toBeLessThanOrEqual(last + 1e-12)
      last = now
    }
  })

  it('drop the role line before the name, when there is not room for both', () => {
    expect(ROLE_MIN_SCALE).toBeGreaterThan(0.55)
    expect(ROLE_MIN_SCALE).toBeLessThanOrEqual(1)
  })
})
