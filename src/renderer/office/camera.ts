import { fitToViewport, type Bounds } from './iso'

/**
 * The office camera, as pure maths so it can be tested. The view is a point of the flat, drawn
 * world (`x`, `y`) held at the centre of the panel, and a zoom relative to the size at which the
 * whole office just fits. Measuring zoom against the fit keeps the picture in proportion when the
 * window is resized or a room is added.
 */

export interface Viewport {
  width: number
  height: number
}

export interface Camera {
  /** 1 shows the whole office; larger is closer. */
  zoom: number
  /** The point of the drawn world at the centre of the panel. */
  x: number
  y: number
}

export interface Transform {
  scale: number
  /** Where the drawn world's origin lands in the panel. */
  x: number
  y: number
}

export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 5
export const ZOOM_STEP = 1.25
export const KEY_PAN = 80
export const FIT_MARGIN = 28
/** How close following brings the picture, if it is further out than this. */
export const FOLLOW_ZOOM = 2.2

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value))

export function centreOf(bounds: Bounds): { x: number; y: number } {
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
}

/** The whole office in view. */
export function fitCamera(bounds: Bounds): Camera {
  return { zoom: 1, ...centreOf(bounds) }
}

/** Pixels per unit of the drawn world at this zoom. */
export function scaleOf(
  camera: Camera,
  bounds: Bounds,
  viewport: Viewport,
  margin = FIT_MARGIN,
): number {
  return fitToViewport(bounds, viewport, margin).scale * camera.zoom
}

/** Where to put and how to scale the drawn world so the camera's point is at the panel's centre. */
export function transformOf(
  camera: Camera,
  bounds: Bounds,
  viewport: Viewport,
  margin = FIT_MARGIN,
): Transform {
  const scale = scaleOf(camera, bounds, viewport, margin)
  return {
    scale,
    x: viewport.width / 2 - camera.x * scale,
    y: viewport.height / 2 - camera.y * scale,
  }
}

/** Keep the centre inside the office, so it can never be dragged out of sight. */
export function clampCamera(camera: Camera, bounds: Bounds): Camera {
  return {
    zoom: clamp(camera.zoom, MIN_ZOOM, MAX_ZOOM),
    x: clamp(camera.x, bounds.minX, bounds.maxX),
    y: clamp(camera.y, bounds.minY, bounds.maxY),
  }
}

/** The point of the drawn world under a point of the panel. */
export function screenToWorld(
  point: { x: number; y: number },
  camera: Camera,
  bounds: Bounds,
  viewport: Viewport,
  margin = FIT_MARGIN,
): { x: number; y: number } {
  const t = transformOf(camera, bounds, viewport, margin)
  return { x: (point.x - t.x) / t.scale, y: (point.y - t.y) / t.scale }
}

/** Zoom by `factor` keeping the point of the world under `anchor` (a point of the panel) still. */
export function zoomAt(
  camera: Camera,
  factor: number,
  anchor: { x: number; y: number },
  bounds: Bounds,
  viewport: Viewport,
  margin = FIT_MARGIN,
): Camera {
  const zoom = clamp(camera.zoom * factor, MIN_ZOOM, MAX_ZOOM)
  if (zoom === camera.zoom) return camera
  const under = screenToWorld(anchor, camera, bounds, viewport, margin)
  const next = { ...camera, zoom }
  const scale = scaleOf(next, bounds, viewport, margin)
  return clampCamera(
    {
      zoom,
      x: under.x - (anchor.x - viewport.width / 2) / scale,
      y: under.y - (anchor.y - viewport.height / 2) / scale,
    },
    bounds,
  )
}

/** Move the picture by (`dx`, `dy`) pixels, as a drag does: the world follows the pointer. */
export function panBy(
  camera: Camera,
  dx: number,
  dy: number,
  bounds: Bounds,
  viewport: Viewport,
  margin = FIT_MARGIN,
): Camera {
  const scale = scaleOf(camera, bounds, viewport, margin)
  return clampCamera({ ...camera, x: camera.x - dx / scale, y: camera.y - dy / scale }, bounds)
}

/**
 * One step of following something: ease the centre toward `target`, and bring the picture in to
 * `FOLLOW_ZOOM` if it is further out (following someone with the whole office in view would only
 * push the office off-centre). It never zooms out someone who is already closer. With reduced
 * motion, jump. `dt` is seconds since the last step.
 */
export function followStep(
  camera: Camera,
  target: { x: number; y: number },
  dt: number,
  reducedMotion: boolean,
  bounds: Bounds,
): Camera {
  const k = reducedMotion ? 1 : 1 - Math.exp(-Math.max(0, dt) * 5)
  let zoom = camera.zoom
  if (zoom < FOLLOW_ZOOM) {
    zoom += (FOLLOW_ZOOM - zoom) * k
    if (FOLLOW_ZOOM - zoom < 0.01) zoom = FOLLOW_ZOOM
  }
  const next = {
    zoom,
    x: camera.x + (target.x - camera.x) * k,
    y: camera.y + (target.y - camera.y) * k,
  }
  // Close enough to stop moving, so the picture settles instead of creeping forever.
  if (Math.abs(target.x - next.x) < 0.05 && Math.abs(target.y - next.y) < 0.05) {
    return clampCamera({ ...next, x: target.x, y: target.y }, bounds)
  }
  return clampCamera(next, bounds)
}

/** How much a turn of the mouse wheel zooms. Lines and pages are turned into pixels first. */
export function wheelFactor(deltaY: number, deltaMode: number): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY
  return Math.exp(-clamp(pixels, -240, 240) * 0.0015)
}

/** Below this drawing scale, the role line under a name is left out: there is no room for it. */
export const ROLE_MIN_SCALE = 0.8
const LABEL_MIN_SCALE = 0.55

/**
 * How big to draw the bubbles and name tags, as a share of their full size. They stay full size when
 * the office is drawn at a normal size and shrink with it when the whole plan is squeezed into a
 * small panel, so neighbours do not pile on top of one another; they never get too small to read.
 */
export function labelScale(worldScale: number): number {
  return clamp(worldScale, LABEL_MIN_SCALE, 1)
}

export type CameraAction =
  | { kind: 'pan'; dx: number; dy: number }
  | { kind: 'zoom'; factor: number }
  | { kind: 'fit' }
  | { kind: 'follow' }

/** What a key does to the camera, or null if it does nothing there. */
export function actionForKey(key: string): CameraAction | null {
  switch (key) {
    case 'ArrowLeft':
      return { kind: 'pan', dx: KEY_PAN, dy: 0 }
    case 'ArrowRight':
      return { kind: 'pan', dx: -KEY_PAN, dy: 0 }
    case 'ArrowUp':
      return { kind: 'pan', dx: 0, dy: KEY_PAN }
    case 'ArrowDown':
      return { kind: 'pan', dx: 0, dy: -KEY_PAN }
    case '+':
    case '=':
      return { kind: 'zoom', factor: ZOOM_STEP }
    case '-':
    case '_':
      return { kind: 'zoom', factor: 1 / ZOOM_STEP }
    case '0':
      return { kind: 'fit' }
    case 'f':
    case 'F':
      return { kind: 'follow' }
    default:
      return null
  }
}
