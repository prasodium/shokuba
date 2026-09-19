import { shade, type Box } from './iso'
import type { Pose } from './pose'

/**
 * Voxel geometry for one employee's workstation, in grid units relative to the desk
 * slot's low corner. The employee sits behind their desk facing +y (toward the camera's
 * left), so we see their face and the back of their monitor; the monitor's status light
 * and the bubble carry the state.
 *
 * Everything is returned back-to-front so it can be painted in order.
 */

/** Footprint of one workstation (chair + desk + monitor). */
export const STATION_WIDTH = 1.8
export const STATION_DEPTH = 1.7

const SKIN = 0xe7b48c
const HAIR = 0x2b2118
const PANTS = 0x3b4a63
const WOOD = 0xb8875a
const WOOD_DARK = 0x8a6240
const CHAIR = 0x3d3731
const METAL = 0x2a2a2e

function box(x: number, y: number, z: number, w: number, d: number, h: number, color: number): Box {
  return { x, y, z, w, d, h, color }
}

/** Rug marking the workstation on the floor. */
export function rug(color: number): Box {
  return box(-0.15, -0.1, 0, STATION_WIDTH + 0.3, STATION_DEPTH + 0.35, 0.02, shade(color, 0.55))
}

/** Chair, drawn before the person (the back is behind them). */
export function chairBoxes(): Box[] {
  return [
    box(0.55, 0.08, 0.3, 0.62, 0.08, 0.6, CHAIR),
    box(0.8, 0.36, 0, 0.12, 0.12, 0.26, METAL),
    box(0.62, 0.26, 0, 0.5, 0.3, 0.04, METAL),
    box(0.55, 0.14, 0.26, 0.62, 0.62, 0.08, shade(CHAIR, 1.15)),
  ]
}

/** The seated person, posed. `shirt` is the employee's colour. */
export function personBoxes(pose: Pose, shirt: number): Box[] {
  if (!pose.present) return []
  const sleeve = shade(shirt, 0.85)
  const hx = pose.headDx
  const hz = pose.headDz

  // Painter's order for a person facing +y: farther parts first. The left arm is on the far
  // (-x) side of the torso, so it goes before it; the right arm is on the near side, after.
  return [
    // legs
    box(0.66, 0.62, 0.02, 0.14, 0.14, 0.26, PANTS),
    box(0.66, 0.32, 0.28, 0.14, 0.44, 0.13, PANTS),
    box(0.92, 0.62, 0.02, 0.14, 0.14, 0.26, PANTS),
    box(0.92, 0.32, 0.28, 0.14, 0.44, 0.13, PANTS),
    // left arm, reaching toward the keyboard
    box(0.5, 0.3, 0.6 + pose.leftArmDz, 0.13, 0.42, 0.13, sleeve),
    box(0.5, 0.7, 0.6 + pose.leftArmDz, 0.13, 0.1, 0.13, SKIN),
    // torso
    box(0.64, 0.26, 0.41, 0.4, 0.28, 0.48, shirt),
    // right arm, which can be raised to get attention
    box(1.04, 0.3, 0.6 + pose.rightArmDz + pose.waveDz, 0.13, 0.42, 0.13, sleeve),
    box(1.04, 0.7, 0.6 + pose.rightArmDz + pose.waveDz, 0.13, 0.1, 0.13, SKIN),
    // head
    box(0.68 + hx, 0.28, 0.89 + hz, 0.34, 0.32, 0.32, SKIN),
    box(0.66 + hx, 0.26, 1.15 + hz, 0.38, 0.36, 0.12, HAIR),
    box(0.66 + hx, 0.24, 0.93 + hz, 0.38, 0.06, 0.24, HAIR),
    // eyes on the +y face of the head
    box(0.74 + hx, 0.6, 1.04 + hz, 0.06, 0.01, 0.06, HAIR),
    box(0.9 + hx, 0.6, 1.04 + hz, 0.06, 0.01, 0.06, HAIR),
  ]
}

/** Desk, monitor and small props; drawn after the person so the desk covers their lap. */
export function deskBoxes(): Box[] {
  return [
    // legs
    box(0.1, 0.9, 0, 0.08, 0.08, 0.56, WOOD_DARK),
    box(1.62, 0.9, 0, 0.08, 0.08, 0.56, WOOD_DARK),
    box(0.1, 1.58, 0, 0.08, 0.08, 0.56, WOOD_DARK),
    box(1.62, 1.58, 0, 0.08, 0.08, 0.56, WOOD_DARK),
    // top
    box(0.05, 0.86, 0.56, 1.7, 0.8, 0.07, WOOD),
    // keyboard, mug
    box(0.55, 0.98, 0.63, 0.6, 0.2, 0.03, 0xd8d2c6),
    box(1.4, 1.05, 0.63, 0.13, 0.13, 0.15, 0xf2efe6),
    // monitor
    box(0.75, 1.22, 0.63, 0.18, 0.16, 0.06, METAL),
    box(0.42, 1.32, 0.69, 0.84, 0.07, 0.5, 0x1f2126),
  ]
}

/** Where the monitor's status light sits (on the face the camera can see). */
export const LED_BOX: Box = box(1.1, 1.39, 0.72, 0.05, 0.01, 0.04, 0xffffff)

/** Where a status bubble is anchored: above the head. */
export const HEAD_ANCHOR = { x: 0.85, y: 0.44, z: 1.65 }
/** Where the name plate goes: on the floor in front of the desk. */
export const NAME_ANCHOR = { x: 0.9, y: 1.85, z: 0 }
