import type { Appearance } from '@shared/appearance'
import { chairBoxes, personBoxes } from './furniture'
import { boxFaces, shade, type Box } from './iso'
import { poseFor } from './pose'

/**
 * A picture of one employee's little person, for the form that edits them. It is drawn from the
 * very geometry the office draws (the same boxes, the same projection and shading), so what the
 * form shows is what the office will. Pure: it only says which polygons to fill, in order; a
 * canvas does the filling.
 */

/** One filled shape: flat x, y pairs in the office's own screen units, and how to fill it. */
export interface PreviewPolygon {
  points: number[]
  color: number
  alpha: number
}

export interface Preview {
  polygons: PreviewPolygon[]
  /** The box round all of them, so the picture can be fitted to its space. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

/** The polygons of a list of boxes, painted in order, each box as its left, right and top. */
export function polygonsOf(boxes: readonly Box[]): PreviewPolygon[] {
  return boxes.flatMap((box) => {
    const faces = boxFaces(box)
    const alpha = box.alpha ?? 1
    return [
      { points: faces.left, color: shade(box.color, 0.82), alpha },
      { points: faces.right, color: shade(box.color, 0.66), alpha },
      { points: faces.top, color: box.color, alpha },
    ]
  })
}

/** Someone sitting on their chair, as they look at their desk, with the shirt colour `shirt`. */
export function previewOf(look: Appearance, shirt: number): Preview {
  const polygons = polygonsOf([...chairBoxes(), ...personBoxes(poseFor('idle', 0), shirt, look)])
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const polygon of polygons) {
    for (let i = 0; i < polygon.points.length; i += 2) {
      const x = polygon.points[i] as number
      const y = polygon.points[i + 1] as number
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
  }
  return { polygons, bounds: { minX, minY, maxX, maxY } }
}

/**
 * How to draw `bounds` into a space `width` by `height` with `margin` round it: the scale, and where
 * the top left of the picture goes. The picture is centred and never stretched.
 */
export function fitPreview(
  bounds: Preview['bounds'],
  width: number,
  height: number,
  margin = 6,
): { scale: number; x: number; y: number } {
  const w = Math.max(1e-6, bounds.maxX - bounds.minX)
  const h = Math.max(1e-6, bounds.maxY - bounds.minY)
  const scale = Math.min((width - margin * 2) / w, (height - margin * 2) / h)
  return {
    scale,
    x: (width - w * scale) / 2 - bounds.minX * scale,
    y: (height - h * scale) / 2 - bounds.minY * scale,
  }
}
