import { DEFAULT_APPEARANCE, hairColor, skinColor, type Appearance } from '@shared/appearance'
import type { Tint } from './handoffs'
import { shade, sortByDepth, type Box } from './iso'
import { GLASS_HEIGHT, PARTITION_HEIGHT, type Point2, type Rect } from './map'
import type { Pose } from './pose'
import type { Facing } from './walker'

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

const EYE = 0x2b2118
const LENS = 0xbfe3f0
const CUPS = 0xe8893a
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

/**
 * A head, from its low corner, facing +y: the head itself, its hair in the chosen style, eyes, and
 * whatever is worn. Seated and standing people share it, so a look is the same in both. `behind` is
 * what falls behind the body (long hair) and must be painted before it; `front` goes after.
 */
function headBoxes(
  look: Appearance,
  shirt: number,
  x: number,
  y: number,
  z: number,
): { behind: Box[]; front: Box[] } {
  const skin = skinColor(look.skin)
  const hair = hairColor(look.hair)
  const capped = look.accessory === 'cap'
  const cap = shade(shirt, 0.8)

  const behind: Box[] =
    look.style === 'long' ? [box(x - 0.02, y - 0.14, z - 0.32, 0.38, 0.12, 0.6, hair)] : []

  const front: Box[] = [box(x, y, z, 0.34, 0.32, 0.32, skin)]
  // A cap covers the top of the head, whatever the hair.
  if (capped) front.push(box(x - 0.02, y - 0.02, z + 0.26, 0.38, 0.36, 0.12, cap))
  else if (look.style !== 'bald')
    front.push(box(x - 0.02, y - 0.02, z + 0.26, 0.38, 0.36, 0.12, hair))
  if (look.style !== 'bald') front.push(box(x - 0.02, y - 0.04, z + 0.04, 0.38, 0.06, 0.24, hair))
  if (look.style === 'bun' && !capped)
    front.push(box(x + 0.09, y + 0.05, z + 0.38, 0.16, 0.16, 0.14, hair))
  // eyes on the +y face of the head
  front.push(box(x + 0.06, y + 0.32, z + 0.15, 0.06, 0.01, 0.06, EYE))
  front.push(box(x + 0.22, y + 0.32, z + 0.15, 0.06, 0.01, 0.06, EYE))

  if (look.accessory === 'glasses') {
    front.push({ ...box(x + 0.03, y + 0.325, z + 0.13, 0.12, 0.01, 0.09, LENS), alpha: 0.6 })
    front.push({ ...box(x + 0.19, y + 0.325, z + 0.13, 0.12, 0.01, 0.09, LENS), alpha: 0.6 })
    front.push(box(x + 0.02, y + 0.33, z + 0.215, 0.14, 0.01, 0.02, METAL))
    front.push(box(x + 0.18, y + 0.33, z + 0.215, 0.14, 0.01, 0.02, METAL))
    front.push(box(x + 0.15, y + 0.33, z + 0.17, 0.04, 0.01, 0.025, METAL))
  } else if (look.accessory === 'headphones') {
    front.push(box(x - 0.03, y + 0.05, z + 0.38, 0.4, 0.06, 0.05, METAL))
    front.push(box(x - 0.04, y + 0.08, z + 0.22, 0.03, 0.05, 0.17, METAL))
    front.push(box(x + 0.35, y + 0.08, z + 0.22, 0.03, 0.05, 0.17, METAL))
    front.push(box(x - 0.09, y + 0.06, z + 0.06, 0.06, 0.18, 0.18, CUPS))
    front.push(box(x + 0.37, y + 0.06, z + 0.06, 0.06, 0.18, 0.18, CUPS))
  } else if (capped) {
    // the peak of the cap, out over the face
    front.push(box(x - 0.03, y + 0.3, z + 0.27, 0.4, 0.14, 0.03, shade(cap, 0.85)))
  }
  return { behind, front }
}

/** The seated person, posed. `shirt` is the employee's colour and `look` how they look. */
export function personBoxes(
  pose: Pose,
  shirt: number,
  look: Appearance = DEFAULT_APPEARANCE,
): Box[] {
  if (!pose.present) return []
  const sleeve = shade(shirt, 0.85)
  const skin = skinColor(look.skin)
  const head = headBoxes(look, shirt, 0.68 + pose.headDx, 0.28, 0.89 + pose.headDz)

  // Painter's order for a person facing +y: farther parts first. The left arm is on the far
  // (-x) side of the torso, so it goes before it; the right arm is on the near side, after.
  return [
    // long hair falls behind the body
    ...head.behind,
    // legs
    box(0.66, 0.62, 0.02, 0.14, 0.14, 0.26, PANTS),
    box(0.66, 0.32, 0.28, 0.14, 0.44, 0.13, PANTS),
    box(0.92, 0.62, 0.02, 0.14, 0.14, 0.26, PANTS),
    box(0.92, 0.32, 0.28, 0.14, 0.44, 0.13, PANTS),
    // left arm, reaching toward the keyboard
    box(0.5, 0.3, 0.6 + pose.leftArmDz, 0.13, 0.42, 0.13, sleeve),
    box(0.5, 0.7, 0.6 + pose.leftArmDz, 0.13, 0.1, 0.13, skin),
    // torso
    box(0.64, 0.26, 0.41, 0.4, 0.28, 0.48, shirt),
    // right arm, which can be raised to get attention
    box(1.04, 0.3, 0.6 + pose.rightArmDz + pose.waveDz, 0.13, 0.42, 0.13, sleeve),
    box(1.04, 0.7, 0.6 + pose.rightArmDz + pose.waveDz, 0.13, 0.1, 0.13, skin),
    // head, hair, eyes and what is worn
    ...head.front,
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

// ---------- the shared places and the walls ----------
//
// Each takes the floor rectangle it stands on and returns its boxes back to front, in the same
// coordinates as the floor plan. They only ever show a place standing idle: what a place shows about
// the real work going on is added on top of these, so an idle office never looks busy.

const CORK = 0xc79a63
const FRAME = 0x7a5738
const SCREEN_OFF = 0x1c1e22
const LEATHER = 0x5a3a2c

/** A partition piece: a low wall. */
export function partitionBox(rect: Rect): Box {
  return { x: rect.x, y: rect.y, z: 0, w: rect.w, d: rect.d, h: PARTITION_HEIGHT, color: 0xd9c9a6 }
}

/** The cap along the top of a partition, a little wider than the wall so it reads as a rail. */
export function partitionCap(rect: Rect): Box {
  const grow = 0.03
  return {
    x: rect.x - grow,
    y: rect.y - grow,
    z: PARTITION_HEIGHT,
    w: rect.w + grow * 2,
    d: rect.d + grow * 2,
    h: 0.05,
    color: 0x8b6f52,
  }
}

/** The mission board: a cork board in a frame, hung on the wall and empty until something is on it. */
export function boardBoxes(footprint: Rect): Box[] {
  const { x, y, w } = footprint
  return [
    box(x, y + 0.02, 0.85, w, 0.12, 1.4, FRAME),
    box(x + 0.1, y + 0.14, 0.95, w - 0.2, 0.04, 1.2, CORK),
  ]
}

/** The QA bench: a long bench with three screens, dark because nothing is being checked. */
export function benchBoxes(footprint: Rect): Box[] {
  const { x, y, w, d } = footprint
  const boxes: Box[] = [
    box(x + 0.08, y + 0.1, 0, 0.1, d - 0.2, 0.7, WOOD_DARK),
    box(x + w - 0.18, y + 0.1, 0, 0.1, d - 0.2, 0.7, WOOD_DARK),
    box(x, y, 0.7, w, d, 0.08, WOOD),
  ]
  const screen = 0.7
  const gap = (w - screen * 3) / 4
  for (let i = 0; i < 3; i += 1) {
    const sx = x + gap + i * (screen + gap)
    boxes.push(box(sx + screen / 2 - 0.08, y + d / 2 - 0.05, 0.78, 0.16, 0.1, 0.06, METAL))
    boxes.push(box(sx, y + d / 2 - 0.05, 0.84, screen, 0.06, 0.42, SCREEN_OFF))
  }
  return boxes
}

/** Where a bench screen is, for lighting it: the face the camera sees. */
export function benchScreens(footprint: Rect): Box[] {
  return benchBoxes(footprint).filter((b) => b.color === SCREEN_OFF)
}

/** The person's desk: an empty leather chair behind a desk with two empty trays. */
export function inboxBoxes(footprint: Rect): Box[] {
  const { x, y, w } = footprint
  const deskY = y + 0.6
  return [
    // chair, behind the desk
    box(x + w / 2 - 0.3, y + 0.05, 0, 0.6, 0.5, 0.06, METAL),
    box(x + w / 2 - 0.3, y + 0.05, 0.06, 0.6, 0.5, 0.42, LEATHER),
    box(x + w / 2 - 0.3, y + 0.02, 0.48, 0.6, 0.1, 0.5, shade(LEATHER, 0.85)),
    // desk
    box(x + 0.06, deskY + 0.06, 0, 0.08, 0.08, 0.66, WOOD_DARK),
    box(x + w - 0.14, deskY + 0.06, 0, 0.08, 0.08, 0.66, WOOD_DARK),
    box(x + 0.06, deskY + 0.76, 0, 0.08, 0.08, 0.66, WOOD_DARK),
    box(x + w - 0.14, deskY + 0.76, 0, 0.08, 0.08, 0.66, WOOD_DARK),
    box(x, deskY, 0.66, w, 0.9, 0.08, WOOD),
    // two empty trays: the pending one and the done one
    box(x + 0.25, deskY + 0.2, 0.74, 0.5, 0.36, 0.04, 0xd8d2c6),
    box(x + 0.25, deskY + 0.2, 0.78, 0.5, 0.02, 0.1, 0xd8d2c6),
    box(x + 0.95, deskY + 0.2, 0.74, 0.5, 0.36, 0.04, 0xa9b9a3),
    box(x + 0.95, deskY + 0.2, 0.78, 0.5, 0.02, 0.1, 0xa9b9a3),
  ]
}

/** The tray the person's pending work goes in, for showing how much is waiting. */
export function inboxTray(footprint: Rect): Box {
  const deskY = footprint.y + 0.6
  return box(footprint.x + 0.25, deskY + 0.2, 0.74, 0.5, 0.36, 0.04, 0xd8d2c6)
}

// ---------- work on the floor ----------
//
// What the shared places show about the real work going on, added on top of the idle furniture
// above: cards on the board, work in the inbox tray, a paper on the desk of someone with a task.

const CARD_COLORS: Record<Tint, number> = {
  plain: 0xf4efe1,
  good: 0x7fc98f,
  bad: 0xe0766b,
  warn: 0xf0b350,
}

/** The colour of a card, by how it is marked. */
export function cardColor(tint: Tint): number {
  return CARD_COLORS[tint]
}

/** The mission board's cards sit in this many columns and rows on the cork. */
export const BOARD_COLUMNS = 6
export const BOARD_ROWS = 2
const CARD_W = 0.34
const CARD_H = 0.44

/** Where card number `index` is pinned on the board (filling a row, then the next below it). */
export function boardCardBox(footprint: Rect, index: number, tint: Tint): Box {
  const column = index % BOARD_COLUMNS
  const row = Math.floor(index / BOARD_COLUMNS)
  const z = row === 0 ? 1.62 : 1.08
  return box(
    footprint.x + 0.2 + column * 0.44,
    footprint.y + 0.18,
    z,
    CARD_W,
    0.03,
    CARD_H,
    CARD_COLORS[tint],
  )
}

/** The cards in the inbox's pending tray, oldest at the bottom, each a little askew. */
export function inboxCardBoxes(footprint: Rect, tints: readonly Tint[]): Box[] {
  const tray = inboxTray(footprint)
  return tints.map((tint, index) =>
    box(
      tray.x + 0.04 + (index % 2 === 0 ? 0 : 0.03),
      tray.y + 0.04 + (index % 3 === 0 ? 0.02 : 0),
      tray.z + tray.h + index * 0.035,
      0.42,
      0.28,
      0.03,
      CARD_COLORS[tint],
    ),
  )
}

/** A paper on a desk, for someone with a task in hand, on the desk top left of the keyboard. */
export function deskPaperBoxes(): Box[] {
  return [
    box(0.16, 1.0, 0.63, 0.3, 0.24, 0.012, CARD_COLORS.plain),
    box(0.2, 1.06, 0.642, 0.2, 0.02, 0.004, 0x9a9384),
    box(0.2, 1.12, 0.642, 0.14, 0.02, 0.004, 0x9a9384),
  ]
}

/** A card or an envelope in the air, centred on a point. */
export function flyingBoxes(
  thing: 'card' | 'envelope',
  at: { x: number; y: number; z: number },
  tint: Tint,
): Box[] {
  if (thing === 'card') {
    return [box(at.x - 0.18, at.y - 0.13, at.z, 0.36, 0.26, 0.03, CARD_COLORS[tint])]
  }
  return [
    box(at.x - 0.17, at.y - 0.11, at.z, 0.34, 0.22, 0.04, 0xfaf7ee),
    box(at.x - 0.17, at.y - 0.11, at.z + 0.04, 0.34, 0.05, 0.005, 0xd9705f),
  ]
}

/** A potted plant. */
export function plantBoxes(footprint: Rect): Box[] {
  const { x, y } = footprint
  return [
    box(x, y, 0, 0.4, 0.4, 0.32, 0xa4583a),
    box(x - 0.08, y - 0.08, 0.32, 0.56, 0.56, 0.3, 0x4f8a4a),
    box(x + 0.03, y + 0.03, 0.62, 0.34, 0.34, 0.3, 0x63a45d),
  ]
}

// ---------- the pantry, the tables and the glass ----------

const STEEL = 0xb9bfc4
const GLASS = 0xbfe3f0
const MUG = 0xf2efe6

/** A run of glass wall: a low frame, a see-through pane and a rail along the top. */
export function glassBoxes(rect: Rect): Box[] {
  const grow = 0.03
  return [
    { x: rect.x, y: rect.y, z: 0, w: rect.w, d: rect.d, h: 0.12, color: 0x8b6f52 },
    {
      x: rect.x,
      y: rect.y,
      z: 0.12,
      w: rect.w,
      d: rect.d,
      h: GLASS_HEIGHT - 0.12,
      color: GLASS,
      alpha: 0.2,
    },
    {
      x: rect.x - grow,
      y: rect.y - grow,
      z: GLASS_HEIGHT,
      w: rect.w + grow * 2,
      d: rect.d + grow * 2,
      h: 0.06,
      color: 0x8b6f52,
    },
  ]
}

/** The tea and coffee counter: a coffee machine, a kettle, mugs and a water dispenser, all cold and still. */
export function teaCounterBoxes(footprint: Rect): Box[] {
  const { x, y, w, d } = footprint
  return [
    box(x, y, 0, w, d, 0.86, WOOD),
    box(x - 0.02, y - 0.02, 0.86, w + 0.04, d + 0.04, 0.05, shade(WOOD, 1.2)),
    // a coffee machine, a kettle and mugs
    box(x + 0.25, y + 0.2, 0.91, 0.42, 0.42, 0.5, METAL),
    box(x + 0.32, y + 0.36, 1.05, 0.28, 0.02, 0.14, 0x3a3f46),
    box(x + 0.9, y + 0.28, 0.91, 0.26, 0.26, 0.3, STEEL),
    box(x + 1.35, y + 0.4, 0.91, 0.12, 0.12, 0.13, MUG),
    box(x + 1.55, y + 0.4, 0.91, 0.12, 0.12, 0.13, MUG),
    // a water dispenser at the end
    box(x + w - 0.6, y + 0.2, 0.91, 0.36, 0.36, 0.62, 0x9ccfe8),
    box(x + w - 0.5, y + 0.3, 1.53, 0.16, 0.16, 0.2, 0xd6ecf6),
  ]
}

/** The snack corner: a shelf with three shelves, stocked. */
export function snackShelfBoxes(footprint: Rect): Box[] {
  const { x, y, w, d } = footprint
  const boxes: Box[] = [
    box(x, y, 0, 0.06, d, 1.7, WOOD_DARK),
    box(x + w - 0.06, y, 0, 0.06, d, 1.7, WOOD_DARK),
    box(x + 0.06, y, 0, w - 0.12, 0.05, 1.7, shade(WOOD_DARK, 0.85)),
  ]
  const snacks = [0xe36a4a, 0xf0c04a, 0x6fb37a, 0x5b8fc7]
  for (const [i, z] of [0.3, 0.8, 1.3].entries()) {
    boxes.push(box(x + 0.06, y + 0.05, z, w - 0.12, d - 0.05, 0.05, WOOD))
    for (let k = 0; k < 4; k += 1) {
      const pack = snacks[(i + k) % snacks.length] as number
      boxes.push(box(x + 0.16 + k * ((w - 0.4) / 4), y + 0.14, z + 0.05, 0.22, 0.16, 0.24, pack))
    }
  }
  return boxes
}

/** A round-topped high table with a stool at each of the given places. */
export function pantryTableBoxes(footprint: Rect, seats: readonly Point2[]): Box[] {
  const { x, y, w, d } = footprint
  return [
    box(x + w / 2 - 0.1, y + d / 2 - 0.1, 0, 0.2, 0.2, 0.9, METAL),
    box(x, y, 0.9, w, d, 0.07, WOOD),
    ...seats.flatMap((s) => [
      box(s.x - 0.08, s.y - 0.08, 0, 0.16, 0.16, 0.5, METAL),
      box(s.x - 0.2, s.y - 0.2, 0.5, 0.4, 0.4, 0.07, 0x3d3731),
    ]),
  ]
}

/** A meeting table with a chair at each of the given places, its back to the table. */
export function meetingTableBoxes(footprint: Rect, seats: readonly Point2[]): Box[] {
  const { x, y, w, d } = footprint
  const towardTable = (s: Point2): number => (s.y < y + d / 2 ? -1 : 1)
  return [
    box(x + 0.2, y + 0.15, 0, 0.14, 0.14, 0.7, WOOD_DARK),
    box(x + w - 0.34, y + 0.15, 0, 0.14, 0.14, 0.7, WOOD_DARK),
    box(x + 0.2, y + d - 0.29, 0, 0.14, 0.14, 0.7, WOOD_DARK),
    box(x + w - 0.34, y + d - 0.29, 0, 0.14, 0.14, 0.7, WOOD_DARK),
    box(x, y, 0.7, w, d, 0.08, WOOD),
    ...seats.flatMap((s) => {
      const away = towardTable(s)
      return [
        box(s.x - 0.22, s.y - 0.22, 0.28, 0.44, 0.44, 0.07, CHAIR),
        box(
          s.x - 0.22,
          s.y + away * 0.2 - (away > 0 ? 0.04 : 0.04),
          0.35,
          0.44,
          0.08,
          0.45,
          shade(CHAIR, 1.15),
        ),
        box(s.x - 0.03, s.y - 0.03, 0, 0.06, 0.06, 0.28, METAL),
      ]
    }),
  ]
}

// ---------- a person on their feet ----------

/** Turn a box about the origin by `turns` quarter turns, so a person can face any of the four ways. */
function turnBox(b: Box, turns: number): Box {
  const spin = (x: number, y: number): Point2 => {
    switch (((turns % 4) + 4) % 4) {
      case 1:
        return { x: y, y: -x }
      case 2:
        return { x: -x, y: -y }
      case 3:
        return { x: -y, y: x }
      default:
        return { x, y }
    }
  }
  const corners = [spin(b.x, b.y), spin(b.x + b.w, b.y + b.d)]
  const x = Math.min(...corners.map((c) => c.x))
  const y = Math.min(...corners.map((c) => c.y))
  return {
    ...b,
    x,
    y,
    w: Math.max(...corners.map((c) => c.x)) - x,
    d: Math.max(...corners.map((c) => c.y)) - y,
  }
}

/** What someone carries back from the pantry. */
export type Held = 'cup' | 'snack'

/** In front of the right hand, in the same local frame as the person: facing +y, about the origin. */
function heldBoxes(holding: Held | null): Box[] {
  if (holding === 'cup') {
    return [
      box(0.19, 0.06, 0.56, 0.13, 0.13, 0.15, 0xf2efe6),
      // the tea or coffee, a little below the rim
      box(0.205, 0.075, 0.69, 0.1, 0.1, 0.02, 0x7a4b2c),
    ]
  }
  if (holding === 'snack') {
    return [
      box(0.17, 0.06, 0.56, 0.17, 0.08, 0.2, 0xd9705f),
      box(0.17, 0.06, 0.64, 0.17, 0.085, 0.05, 0xf0b350),
    ]
  }
  return []
}

/**
 * A person standing or walking, centred on `at` on the floor. `phase` is how far through a stride
 * they are (0 to 1); legs and arms swing opposite to each other while `walking`, and hang still
 * otherwise. Boxes come back in painter's order for the way they are facing.
 */
export function walkerBoxes(
  at: Point2,
  facing: Facing,
  phase: number,
  walking: boolean,
  shirt: number,
  holding: Held | null = null,
  look: Appearance = DEFAULT_APPEARANCE,
): Box[] {
  const swing = walking ? Math.sin(phase * Math.PI * 2) : 0
  const sleeve = shade(shirt, 0.85)
  const head = headBoxes(look, shirt, -0.17, -0.16, 1.1)
  // Built facing +y, about the origin; turned and moved afterwards.
  const local: Box[] = [
    // legs, one stepping forward as the other goes back
    box(-0.19, -0.07 + 0.15 * swing, 0, 0.14, 0.14, 0.58, PANTS),
    box(0.05, -0.07 - 0.15 * swing, 0, 0.14, 0.14, 0.58, PANTS),
    // arms hang from the shoulders and swing against the legs
    box(-0.32, -0.055 - 0.1 * swing, 0.6, 0.11, 0.11, 0.46, sleeve),
    box(0.21, -0.055 + 0.1 * swing, 0.6, 0.11, 0.11, 0.46, sleeve),
    // torso
    box(-0.2, -0.12, 0.58, 0.4, 0.24, 0.5, shirt),
    // head, with hair, eyes on the face that looks the way they walk, and what is worn
    ...head.behind,
    ...head.front,
    ...heldBoxes(holding),
  ]
  const placed = local.map((b) => {
    const t = turnBox(b, facing)
    return { ...t, x: t.x + at.x, y: t.y + at.y }
  })
  return sortByDepth(placed)
}
