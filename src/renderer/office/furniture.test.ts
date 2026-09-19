import { describe, expect, it } from 'vitest'
import {
  STATION_DEPTH,
  STATION_WIDTH,
  benchBoxes,
  benchScreens,
  boardBoxes,
  chairBoxes,
  deskBoxes,
  inboxBoxes,
  inboxTray,
  partitionBox,
  partitionCap,
  personBoxes,
  plantBoxes,
  rug,
} from './furniture'
import { PARTITION_HEIGHT, buildOffice, type Rect } from './map'
import { poseFor } from './pose'

const everything = () => [
  rug(0xe8893a),
  ...chairBoxes(),
  ...personBoxes(poseFor('coding', 0.05), 0xe8893a),
  ...deskBoxes(),
]

describe('workstation geometry', () => {
  it('keeps every box inside the station footprint and above the floor', () => {
    for (const b of everything()) {
      expect(b.z).toBeGreaterThanOrEqual(0)
      expect(b.w).toBeGreaterThan(0)
      expect(b.d).toBeGreaterThan(0)
      expect(b.h).toBeGreaterThan(0)
      // The rug deliberately overhangs the station a little.
      expect(b.x).toBeGreaterThanOrEqual(-0.2)
      expect(b.y).toBeGreaterThanOrEqual(-0.2)
      expect(b.x + b.w).toBeLessThanOrEqual(STATION_WIDTH + 0.2)
      expect(b.y + b.d).toBeLessThanOrEqual(STATION_DEPTH + 0.3)
    }
  })

  it('seats nobody when the agent is offline', () => {
    expect(personBoxes(poseFor('offline', 0), 0xe8893a)).toEqual([])
  })

  it('dresses the employee in their chosen colour', () => {
    const shirt = 0x3366cc
    expect(personBoxes(poseFor('idle', 0), shirt).some((b) => b.color === shirt)).toBe(true)
  })

  it('moves the arms with the pose, so typing is visible', () => {
    const still = personBoxes(poseFor('idle', 0), 0x123456)
    const typing = personBoxes({ ...poseFor('coding', 0), leftArmDz: 0.04 }, 0x123456)
    expect(typing.some((b, i) => b.z !== still[i]?.z)).toBe(true)
  })

  it('raises the right arm when the agent needs attention', () => {
    const idle = personBoxes(poseFor('idle', 0), 0x123456)
    const waiting = personBoxes(poseFor('waiting', 0), 0x123456)
    const rightArm = (boxes: typeof idle) => boxes.find((b) => b.x === 1.04)?.z ?? 0
    expect(rightArm(waiting)).toBeGreaterThan(rightArm(idle) + 0.3)
  })

  it('puts the desk in front of (at larger y than) the person', () => {
    const desk = deskBoxes().find((b) => b.w > 1.5)
    const torso = personBoxes(poseFor('idle', 0), 0x123456).find((b) => b.h === 0.48)
    expect(desk?.y ?? 0).toBeGreaterThan((torso?.y ?? 99) + (torso?.d ?? 0) / 2)
  })
})

describe('the shared places', () => {
  const map = buildOffice(1)
  const footprint = (id: string): Rect => map.places.find((p) => p.id === id)?.footprint as Rect

  /** Every box sits on the floor within its footprint (plants and rails overhang a little). */
  function fits(boxes: ReturnType<typeof benchBoxes>, rect: Rect, overhang = 0.1): void {
    for (const b of boxes) {
      expect(b.z).toBeGreaterThanOrEqual(0)
      expect(b.w).toBeGreaterThan(0)
      expect(b.d).toBeGreaterThan(0)
      expect(b.h).toBeGreaterThan(0)
      expect(b.x).toBeGreaterThanOrEqual(rect.x - overhang)
      expect(b.y).toBeGreaterThanOrEqual(rect.y - overhang)
      expect(b.x + b.w).toBeLessThanOrEqual(rect.x + rect.w + overhang)
      expect(b.y + b.d).toBeLessThanOrEqual(rect.y + rect.d + overhang)
    }
  }

  it('stay inside the floor they were given', () => {
    fits(boardBoxes(footprint('board')), footprint('board'))
    fits(benchBoxes(footprint('qa')), footprint('qa'))
    fits(inboxBoxes(footprint('inbox')), footprint('inbox'))
    for (const plant of map.props) fits(plantBoxes(plant.footprint), plant.footprint)
  })

  it('stand idle: the board is bare, the bench screens are dark, and the trays are empty', () => {
    // A board is just a frame and a cork panel: no cards, until something real is put on it.
    expect(boardBoxes(footprint('board'))).toHaveLength(2)
    const screens = benchScreens(footprint('qa'))
    expect(screens).toHaveLength(3)
    expect(new Set(screens.map((b) => b.color)).size).toBe(1)
    // Two trays: nothing is stacked in either.
    const inbox = inboxBoxes(footprint('inbox'))
    const tray = inboxTray(footprint('inbox'))
    expect(inbox.some((b) => b.x === tray.x && b.y === tray.y && b.z === tray.z)).toBe(true)
    expect(inbox.filter((b) => b.z > 0.8)).toEqual([])
  })

  it('put the person’s chair behind their desk, as at any other desk', () => {
    const boxes = inboxBoxes(footprint('inbox'))
    const desk = boxes.find((b) => b.h === 0.08 && b.w === footprint('inbox').w)
    const seat = boxes.find((b) => b.h === 0.42)
    expect(desk?.y ?? 0).toBeGreaterThan((seat?.y ?? 99) + (seat?.d ?? 0) - 0.01)
  })
})

describe('walls', () => {
  const piece: Rect = { x: 8 - 0.08, y: 1, w: 0.16, d: 0.25 }

  it('are low, so nothing behind them is hidden', () => {
    expect(partitionBox(piece).h).toBe(PARTITION_HEIGHT)
    expect(PARTITION_HEIGHT).toBeLessThan(1.2)
  })

  it('have a rail on top, a little wider than the wall and sitting on it', () => {
    const cap = partitionCap(piece)
    const wall = partitionBox(piece)
    expect(cap.z).toBe(wall.h)
    expect(cap.w).toBeGreaterThan(wall.w)
    expect(cap.d).toBeGreaterThan(wall.d)
    expect(cap.x).toBeLessThan(wall.x)
  })

  it('cover the floor they were given, exactly', () => {
    const wall = partitionBox(piece)
    expect([wall.x, wall.y, wall.w, wall.d]).toEqual([piece.x, piece.y, piece.w, piece.d])
  })
})
