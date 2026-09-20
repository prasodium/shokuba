import { describe, expect, it } from 'vitest'
import {
  ACCESSORIES,
  DEFAULT_APPEARANCE,
  HAIR_COLORS,
  HAIR_STYLES,
  SKIN_TONES,
  hairColor,
  skinColor,
  type Appearance,
} from '@shared/appearance'
import {
  BOARD_COLUMNS,
  BOARD_ROWS,
  STATION_DEPTH,
  STATION_WIDTH,
  benchBoxes,
  benchScreens,
  boardBoxes,
  boardCardBox,
  cardColor,
  chairBoxes,
  deskBoxes,
  deskPaperBoxes,
  flyingBoxes,
  glassBoxes,
  inboxBoxes,
  inboxCardBoxes,
  inboxTray,
  meetingTableBoxes,
  pantryTableBoxes,
  partitionBox,
  partitionCap,
  personBoxes,
  plantBoxes,
  rug,
  snackShelfBoxes,
  teaCounterBoxes,
  walkerBoxes,
} from './furniture'
import { shade, type Box } from './iso'
import { GLASS_HEIGHT, PARTITION_HEIGHT, buildOffice, type Point2, type Rect } from './map'
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
  const map = buildOffice()
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

describe('a person on their feet', () => {
  const here = { x: 10, y: 6 }
  const still = (facing: 0 | 1 | 2 | 3) => walkerBoxes(here, facing, 0, false, 0x336699)

  it('stands on the floor, about a person’s height, around the point they are at', () => {
    for (const facing of [0, 1, 2, 3] as const) {
      const boxes = still(facing)
      expect(Math.min(...boxes.map((b) => b.z))).toBe(0)
      const top = Math.max(...boxes.map((b) => b.z + b.h))
      expect(top).toBeGreaterThan(1.3)
      expect(top).toBeLessThan(1.7)
      for (const b of boxes) {
        expect(b.w).toBeGreaterThan(0)
        expect(b.d).toBeGreaterThan(0)
        expect(b.x).toBeGreaterThan(here.x - 0.5)
        expect(b.x + b.w).toBeLessThan(here.x + 0.5)
        expect(b.y).toBeGreaterThan(here.y - 0.5)
        expect(b.y + b.d).toBeLessThan(here.y + 0.5)
      }
    }
  })

  it('is dressed in their colour, and has the same parts whichever way they face', () => {
    for (const facing of [0, 1, 2, 3] as const) {
      expect(still(facing).some((b) => b.color === 0x336699)).toBe(true)
      expect(still(facing)).toHaveLength(still(0).length)
    }
  })

  it('has their face on the side they are facing, and their back to where they came from', () => {
    const eyes = (facing: 0 | 1 | 2 | 3) =>
      still(facing).filter((b) => b.h === 0.06 && b.w * b.d < 0.001 + 0.06 * 0.01)
    // Facing +y the eyes are in front (larger y); facing -y they are behind (smaller y).
    expect(eyes(0).every((b) => b.y > here.y)).toBe(true)
    expect(eyes(2).every((b) => b.y < here.y)).toBe(true)
    expect(eyes(1).every((b) => b.x > here.x)).toBe(true)
    expect(eyes(3).every((b) => b.x < here.x)).toBe(true)
  })

  it('swings the legs one against the other, and the arms against the legs, while walking', () => {
    const legs = (phase: number) =>
      walkerBoxes(here, 0, phase, true, 0x336699)
        .filter((b) => b.h === 0.58)
        .sort((a, b) => a.x - b.x)
    const early = legs(0.25)
    const late = legs(0.75)
    expect(early[0]?.y).not.toBeCloseTo(early[1]?.y ?? 0)
    // Half a stride on, the legs have swapped places.
    expect(early[0]?.y).toBeCloseTo(late[1]?.y ?? 0, 5)
    expect(early[1]?.y).toBeCloseTo(late[0]?.y ?? 0, 5)
  })

  it('hangs still when not walking, whatever the phase', () => {
    const a = walkerBoxes(here, 0, 0.25, false, 0x336699)
    const b = walkerBoxes(here, 0, 0.75, false, 0x336699)
    expect(a).toEqual(b)
  })

  describe('carrying something from the pantry', () => {
    const empty = (facing: 0 | 1 | 2 | 3) => walkerBoxes(here, facing, 0, false, 0x336699)
    const carrying = (facing: 0 | 1 | 2 | 3, held: 'cup' | 'snack') =>
      walkerBoxes(here, facing, 0, false, 0x336699, held)
    /** What they carry: the boxes that are not part of the empty-handed person. */
    const extra = (facing: 0 | 1 | 2 | 3, held: 'cup' | 'snack') =>
      carrying(facing, held).filter(
        (b) => !empty(facing).some((e) => JSON.stringify(e) === JSON.stringify(b)),
      )

    it('is nothing at all when they carry nothing', () => {
      for (const facing of [0, 1, 2, 3] as const) {
        expect(walkerBoxes(here, facing, 0, false, 0x336699, null)).toEqual(empty(facing))
      }
    })

    it('adds a few boxes for a cup and for a snack, and they look different', () => {
      for (const facing of [0, 1, 2, 3] as const) {
        const cup = extra(facing, 'cup')
        const snack = extra(facing, 'snack')
        expect(cup.length).toBeGreaterThan(0)
        expect(snack.length).toBeGreaterThan(0)
        expect(cup.map((b) => b.color)).not.toEqual(snack.map((b) => b.color))
        // Nothing else about the person changes.
        expect(carrying(facing, 'cup')).toHaveLength(empty(facing).length + cup.length)
      }
    })

    it('holds it out in front, at about the height of the hand, and small', () => {
      for (const held of ['cup', 'snack'] as const) {
        for (const b of extra(0, held)) {
          expect(b.y).toBeGreaterThan(here.y)
          expect(b.z).toBeGreaterThan(0.4)
          expect(b.z + b.h).toBeLessThan(1)
          expect(b.w).toBeLessThan(0.25)
        }
      }
    })

    it('turns with them, always in front of whichever way they face', () => {
      for (const held of ['cup', 'snack'] as const) {
        expect(extra(2, held).every((b) => b.y + b.d < here.y)).toBe(true)
        expect(extra(1, held).every((b) => b.x > here.x)).toBe(true)
        expect(extra(3, held).every((b) => b.x + b.w < here.x)).toBe(true)
      }
    })

    it('stays inside the space a person takes, so it never collides with more than they do', () => {
      for (const held of ['cup', 'snack'] as const) {
        for (const b of carrying(1, held)) {
          expect(Math.hypot(b.x - here.x, b.y - here.y)).toBeLessThan(0.6)
        }
      }
    })
  })

  it('is drawn farthest part first, so nothing is hidden the wrong way round', () => {
    for (const facing of [0, 1, 2, 3] as const) {
      const boxes = walkerBoxes(here, facing, 0.3, true, 0x336699)
      const key = (b: (typeof boxes)[number]) => b.x + b.w / 2 + b.y + b.d / 2 + b.z * 0.01
      for (let i = 1; i < boxes.length; i += 1) {
        expect(key(boxes[i] as (typeof boxes)[number])).toBeGreaterThanOrEqual(
          key(boxes[i - 1] as (typeof boxes)[number]) - 1e-9,
        )
      }
    }
  })
})

describe('the pantry, the tables and the glass', () => {
  const map = buildOffice()
  const place = (id: string) => map.places.find((p) => p.id === id) as (typeof map.places)[number]
  const inside = (boxes: ReturnType<typeof teaCounterBoxes>, rect: Rect, overhang = 0.1): void => {
    for (const b of boxes) {
      expect(b.w).toBeGreaterThan(0)
      expect(b.d).toBeGreaterThan(0)
      expect(b.h).toBeGreaterThan(0)
      expect(b.z).toBeGreaterThanOrEqual(0)
      expect(b.x).toBeGreaterThanOrEqual(rect.x - overhang)
      expect(b.y).toBeGreaterThanOrEqual(rect.y - overhang)
      expect(b.x + b.w).toBeLessThanOrEqual(rect.x + rect.w + overhang)
      expect(b.y + b.d).toBeLessThanOrEqual(rect.y + rect.d + overhang)
    }
  }

  describe('glass', () => {
    const piece: Rect = { x: 6 - 0.08, y: 1, w: 0.16, d: 0.25 }

    it('is a see-through pane as tall as a person and a little, in a frame with a rail on top', () => {
      const boxes = glassBoxes(piece)
      const panes = boxes.filter((b) => b.alpha !== undefined)
      expect(panes).toHaveLength(1)
      const pane = panes[0] as (typeof boxes)[number]
      expect(pane.alpha).toBeGreaterThan(0)
      expect(pane.alpha).toBeLessThan(0.5)
      expect(pane.z + pane.h).toBeCloseTo(GLASS_HEIGHT)
      expect(GLASS_HEIGHT).toBeGreaterThan(PARTITION_HEIGHT * 2)
      // Only the pane is see-through: the frame below it and the rail above it are solid.
      const rail = boxes.find((b) => b.z >= GLASS_HEIGHT - 1e-9)
      expect(rail?.alpha).toBeUndefined()
      expect(boxes.find((b) => b.z === 0)?.alpha).toBeUndefined()
    })

    it('stands on exactly the floor it was given, a rail overhanging a little', () => {
      inside(glassBoxes(piece), piece, 0.05)
      const pane = glassBoxes(piece).find((b) => b.alpha !== undefined)
      expect([pane?.x, pane?.y, pane?.w, pane?.d]).toEqual([piece.x, piece.y, piece.w, piece.d])
    })
  })

  describe('the QA bench', () => {
    const footprint = place('qa').footprint
    const boxes = benchBoxes(footprint)

    it('is a bench at working height with three screens standing on it, dark until something is checked', () => {
      const top = boxes.find((b) => b.w === footprint.w && b.d === footprint.d)
      expect(top?.z).toBeCloseTo(0.7)
      const screens = benchScreens(footprint)
      expect(screens).toHaveLength(3)
      for (const screen of screens)
        expect(screen.z).toBeGreaterThan((top?.z ?? 0) + (top?.h ?? 0) - 1e-9)
      inside(boxes, footprint)
    })
  })

  describe('the pantry', () => {
    it('has a tea and coffee counter with a coffee machine, a kettle, mugs and water', () => {
      const boxes = teaCounterBoxes(place('tea').footprint)
      inside(boxes, place('tea').footprint)
      expect(boxes.length).toBeGreaterThanOrEqual(8)
      // The counter itself is waist height, with things standing on it.
      expect(boxes.filter((b) => b.z >= 0.85).length).toBeGreaterThanOrEqual(6)
    })

    it('has a snack shelf with three shelves, every one stocked, and never anything that moves', () => {
      const footprint = place('snacks').footprint
      const boxes = snackShelfBoxes(footprint)
      inside(boxes, footprint)
      const shelves = boxes.filter((b) => b.h === 0.05)
      expect(shelves).toHaveLength(3)
      for (const shelf of shelves) {
        const stock = boxes.filter((b) => Math.abs(b.z - (shelf.z + 0.05)) < 1e-9)
        expect(stock.length).toBeGreaterThanOrEqual(3)
      }
    })

    it('has a high table with a stool at each place, at the place', () => {
      const table = place('pantry-table')
      const boxes = pantryTableBoxes(table.footprint, table.slots)
      const seats = boxes.filter((b) => Math.abs(b.w - 0.4) < 1e-9 && Math.abs(b.z - 0.5) < 1e-9)
      expect(seats).toHaveLength(table.slots.length)
      for (const slot of table.slots) {
        expect(
          seats.some(
            (b) =>
              Math.abs(b.x + b.w / 2 - slot.x) < 1e-9 && Math.abs(b.y + b.d / 2 - slot.y) < 1e-9,
          ),
        ).toBe(true)
      }
      // The tabletop is higher than a desk: it is a place to stand at.
      expect(Math.max(...boxes.map((b) => b.z + b.h))).toBeGreaterThan(0.9)
    })
  })

  describe('the meeting table', () => {
    const table = place('meeting-table')
    const boxes = meetingTableBoxes(table.footprint, table.slots)

    it('has a chair at each of its six places', () => {
      const seats = boxes.filter((b) => Math.abs(b.w - 0.44) < 1e-9 && Math.abs(b.d - 0.44) < 1e-9)
      expect(seats).toHaveLength(6)
      for (const slot of table.slots) {
        expect(
          seats.some(
            (b) =>
              Math.abs(b.x + b.w / 2 - slot.x) < 1e-9 && Math.abs(b.y + b.d / 2 - slot.y) < 1e-9,
          ),
        ).toBe(true)
      }
    })

    it('turns every chair’s back away from the table', () => {
      const middle = table.footprint.y + table.footprint.d / 2
      const backs = boxes.filter((b) => Math.abs(b.d - 0.08) < 1e-9 && Math.abs(b.h - 0.45) < 1e-9)
      expect(backs).toHaveLength(6)
      for (const slot of table.slots as Point2[]) {
        // The back that belongs to this seat: the nearest one along the same line across the table.
        const back = backs
          .filter((b) => Math.abs(b.x + b.w / 2 - slot.x) < 1e-9)
          .sort(
            (a, b) => Math.abs(a.y - slot.y) - Math.abs(b.y - slot.y),
          )[0] as (typeof backs)[number]
        // Seats on the far side have their back further away (smaller y); on the near side, larger.
        expect(slot.y < middle ? back.y < slot.y : back.y > slot.y).toBe(true)
      }
    })

    it('has a tabletop at table height, on legs', () => {
      const top = boxes.find((b) => b.w === table.footprint.w && b.d === table.footprint.d)
      expect(top?.z).toBeCloseTo(0.7)
      expect(boxes.filter((b) => b.h === 0.7 && b.w === 0.14)).toHaveLength(4)
    })
  })
})

describe('work on the floor', () => {
  const board = { x: 20.2, y: 0, w: 3.0, d: 0.3 }
  const inbox = { x: 12.0, y: 1.3, w: 2.0, d: 1.5 }
  const tints = ['plain', 'good', 'bad', 'warn'] as const

  describe('the mission board', () => {
    const cork = boardBoxes(board)[1] as Box

    it('has room for every card it is given, each on the cork and none on another', () => {
      const cards = Array.from({ length: BOARD_COLUMNS * BOARD_ROWS }, (_, i) =>
        boardCardBox(board, i, 'plain'),
      )
      for (const c of cards) {
        expect(c.x).toBeGreaterThanOrEqual(cork.x)
        expect(c.x + c.w).toBeLessThanOrEqual(cork.x + cork.w)
        expect(c.z).toBeGreaterThanOrEqual(cork.z)
        expect(c.z + c.h).toBeLessThanOrEqual(cork.z + cork.h)
        // In front of the cork's face, so it can be seen, and thin.
        expect(c.y).toBeGreaterThanOrEqual(cork.y + cork.d - 1e-9)
        expect(c.d).toBeLessThan(0.1)
      }
      const overlap = (a: Box, b: Box) =>
        a.x < b.x + b.w && b.x < a.x + a.w && a.z < b.z + b.h && b.z < a.z + a.h
      for (let i = 0; i < cards.length; i += 1) {
        for (let j = i + 1; j < cards.length; j += 1) {
          expect(overlap(cards[i] as Box, cards[j] as Box), `${i} and ${j}`).toBe(false)
        }
      }
    })

    it('fills a row before the next one down, left to right', () => {
      const at = (i: number) => boardCardBox(board, i, 'plain')
      for (let i = 1; i < BOARD_COLUMNS; i += 1) {
        expect(at(i).x).toBeGreaterThan(at(i - 1).x)
        expect(at(i).z).toBe(at(0).z)
      }
      expect(at(BOARD_COLUMNS).x).toBe(at(0).x)
      expect(at(BOARD_COLUMNS).z).toBeLessThan(at(0).z)
    })

    it('colours a card by its tint, and each tint differently', () => {
      const colors = tints.map((t) => boardCardBox(board, 0, t).color)
      expect(new Set(colors).size).toBe(tints.length)
      tints.forEach((t, i) => expect(colors[i]).toBe(cardColor(t)))
    })
  })

  describe('the inbox tray', () => {
    const tray = inboxTray(inbox)

    it('holds no cards when nothing is waiting', () => {
      expect(inboxCardBoxes(inbox, [])).toEqual([])
    })

    it('stacks the cards upward on the tray, each above the last, inside its edges', () => {
      const cards = inboxCardBoxes(inbox, ['plain', 'good', 'bad', 'warn', 'plain', 'plain'])
      expect(cards).toHaveLength(6)
      cards.forEach((c, i) => {
        expect(c.x).toBeGreaterThanOrEqual(tray.x)
        expect(c.x + c.w).toBeLessThanOrEqual(tray.x + tray.w + 0.02)
        expect(c.y).toBeGreaterThanOrEqual(tray.y)
        expect(c.y + c.d).toBeLessThanOrEqual(tray.y + tray.d + 0.02)
        expect(c.z).toBeGreaterThanOrEqual(tray.z + tray.h)
        if (i > 0) expect(c.z).toBeGreaterThan((cards[i - 1] as Box).z)
      })
    })

    it('colours each card by its own tint, bottom first', () => {
      const cards = inboxCardBoxes(inbox, ['bad', 'good'])
      expect(cards.map((c) => c.color)).toEqual([cardColor('bad'), cardColor('good')])
    })
  })

  describe('a paper on a desk', () => {
    it('lies on the desk top, clear of the keyboard and the monitor', () => {
      const top = deskBoxes()[4] as Box
      const keyboard = deskBoxes()[5] as Box
      const paper = deskPaperBoxes()
      expect(paper.length).toBeGreaterThan(0)
      for (const b of paper) {
        expect(b.z).toBeGreaterThanOrEqual(top.z + top.h - 1e-9)
        expect(b.x).toBeGreaterThanOrEqual(top.x)
        expect(b.x + b.w).toBeLessThanOrEqual(top.x + top.w)
        expect(b.y).toBeGreaterThanOrEqual(top.y)
        expect(b.y + b.d).toBeLessThanOrEqual(top.y + top.d)
        expect(b.x + b.w).toBeLessThanOrEqual(keyboard.x)
      }
    })
  })

  describe('things in the air', () => {
    const at = { x: 5, y: 6, z: 1 }

    it('centre a card on the point, in its tint', () => {
      const [card] = flyingBoxes('card', at, 'bad')
      expect(card).toBeDefined()
      const c = card as Box
      expect(c.x + c.w / 2).toBeCloseTo(5)
      expect(c.y + c.d / 2).toBeCloseTo(6)
      expect(c.z).toBe(1)
      expect(c.color).toBe(cardColor('bad'))
    })

    it('centre an envelope on the point, and its own colour whatever the tint', () => {
      const boxes = flyingBoxes('envelope', at, 'bad')
      expect(boxes.length).toBeGreaterThan(1)
      const [body] = boxes as [Box, ...Box[]]
      expect(body.x + body.w / 2).toBeCloseTo(5)
      expect(body.y + body.d / 2).toBeCloseTo(6)
      expect(boxes.some((b) => b.color === cardColor('bad'))).toBe(false)
      expect(flyingBoxes('envelope', at, 'good')).toEqual(boxes)
    })

    it('are told from each other', () => {
      expect(flyingBoxes('card', at, 'plain')).not.toEqual(flyingBoxes('envelope', at, 'plain'))
    })
  })
})

describe('how someone looks', () => {
  const shirt = 0x336699
  const seated = (look: Partial<Appearance>) =>
    personBoxes(poseFor('idle', 0), shirt, { ...DEFAULT_APPEARANCE, ...look })
  const standing = (look: Partial<Appearance>, facing: 0 | 1 | 2 | 3 = 0) =>
    walkerBoxes({ x: 10, y: 6 }, facing, 0, false, shirt, null, { ...DEFAULT_APPEARANCE, ...look })
  const colored = (boxes: Box[], color: number) => boxes.filter((b) => b.color === color)
  const combos = HAIR_STYLES.flatMap((style) =>
    ACCESSORIES.map((accessory) => ({ style: style.id, accessory: accessory.id })),
  )

  it('is, by default, exactly the look everyone had before', () => {
    expect(personBoxes(poseFor('idle', 0), shirt)).toEqual(seated({}))
    expect(walkerBoxes({ x: 10, y: 6 }, 0, 0, false, shirt)).toEqual(standing({}))
    expect(colored(seated({}), 0xe7b48c).length).toBeGreaterThan(0)
    expect(colored(seated({}), 0x2b2118).length).toBeGreaterThan(0)
  })

  it('keeps every part inside the workstation for every style and accessory', () => {
    for (const combo of combos) {
      for (const b of seated(combo)) {
        expect(b.w, JSON.stringify(combo)).toBeGreaterThan(0)
        expect(b.x).toBeGreaterThanOrEqual(-0.2)
        expect(b.y).toBeGreaterThanOrEqual(-0.2)
        expect(b.x + b.w).toBeLessThanOrEqual(STATION_WIDTH + 0.2)
        expect(b.y + b.d).toBeLessThanOrEqual(STATION_DEPTH + 0.3)
        expect(b.z).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('keeps every part of a walking person within a person’s space, and the same parts whichever way they face', () => {
    for (const combo of combos) {
      const counts = new Set<number>()
      for (const facing of [0, 1, 2, 3] as const) {
        const boxes = standing(combo, facing)
        counts.add(boxes.length)
        for (const b of boxes) {
          expect(b.x, JSON.stringify(combo)).toBeGreaterThan(10 - 0.6)
          expect(b.x + b.w).toBeLessThan(10 + 0.6)
          expect(b.y).toBeGreaterThan(6 - 0.6)
          expect(b.y + b.d).toBeLessThan(6 + 0.6)
          expect(Math.max(...boxes.map((c) => c.z + c.h))).toBeLessThan(1.9)
        }
      }
      expect(counts.size, JSON.stringify(combo)).toBe(1)
    }
  })

  it('draws the chosen skin on the head and hands, and never anywhere else', () => {
    for (const tone of SKIN_TONES) {
      const color = skinColor(tone.id)
      const boxes = seated({ skin: tone.id })
      // the head and two hands
      expect(colored(boxes, color)).toHaveLength(3)
      expect(colored(standing({ skin: tone.id }), color)).toHaveLength(1)
    }
  })

  it('draws the chosen hair colour on the hair, and only there', () => {
    for (const shade of HAIR_COLORS) {
      const color = hairColor(shade.id)
      expect(colored(seated({ hair: shade.id }), color).length).toBeGreaterThanOrEqual(2)
      expect(colored(standing({ hair: shade.id }), color).length).toBeGreaterThanOrEqual(2)
    }
  })

  it('keeps the eyes dark whatever the hair colour', () => {
    const eyes = (boxes: Box[]) => boxes.filter((b) => b.h === 0.06 && b.d === 0.01)
    for (const shade of HAIR_COLORS) {
      const found = eyes(seated({ hair: shade.id }))
      expect(found).toHaveLength(2)
      for (const eye of found) expect(eye.color).toBe(0x2b2118)
    }
  })

  it('is bald with no hair at all', () => {
    // Not black, which is also the colour of the eyes.
    const hair = hairColor('blonde')
    expect(colored(seated({ style: 'bald', hair: 'blonde' }), hair)).toHaveLength(0)
    expect(colored(standing({ style: 'bald', hair: 'blonde' }), hair)).toHaveLength(0)
    expect(colored(seated({ style: 'short', hair: 'blonde' }), hair).length).toBeGreaterThan(0)
  })

  it('gives long hair behind the body and a bun on top, and no more than short hair otherwise', () => {
    const short = seated({ style: 'short' })
    const long = seated({ style: 'long' })
    const bun = seated({ style: 'bun' })
    expect(long).toHaveLength(short.length + 1)
    expect(bun).toHaveLength(short.length + 1)
    const hair = hairColor('black')
    // The long hair is painted first, behind everything, so the body covers it.
    const torso = long.findIndex((b) => b.color === shirt)
    const behind = long.findIndex((b) => b.color === hair)
    expect(behind).toBeGreaterThanOrEqual(0)
    expect(behind).toBeLessThan(torso)
    // The bun sits above the top of the hair.
    const topOf = (boxes: Box[]) => Math.max(...colored(boxes, hair).map((b) => b.z + b.h))
    expect(topOf(bun)).toBeGreaterThan(topOf(short))
    expect(topOf(long)).toBeCloseTo(topOf(short))
  })

  it('shows glasses as two lenses you can see through, headphones as a band and two cups, a cap as a crown and a peak', () => {
    const base = seated({}).length
    const glasses = seated({ accessory: 'glasses' })
    expect(glasses.filter((b) => (b.alpha ?? 1) < 1)).toHaveLength(2)
    expect(glasses.length).toBeGreaterThan(base)
    const phones = seated({ accessory: 'headphones' })
    expect(phones.length).toBe(base + 5)
    expect(phones.filter((b) => b.color === 0xe8893a)).toHaveLength(2)
    const cap = seated({ accessory: 'cap' })
    // A cap replaces the top of the hair with a crown, and adds a peak.
    expect(cap.length).toBe(base + 1)
    expect(cap.some((b) => b.color === shade(shirt, 0.8))).toBe(true)
    expect(seated({ accessory: 'none' })).toHaveLength(base)
  })

  it('hides the top of the hair, and a bun, under a cap', () => {
    const hair = hairColor('black')
    const topHair = (boxes: Box[]) => boxes.filter((b) => b.color === hair && b.h === 0.12)
    expect(topHair(seated({}))).toHaveLength(1)
    expect(topHair(seated({ accessory: 'cap' }))).toHaveLength(0)
    expect(colored(seated({ style: 'bun', accessory: 'cap' }), hair)).toHaveLength(
      colored(seated({ style: 'short', accessory: 'cap' }), hair).length,
    )
  })

  it('changes nothing about the body', () => {
    const body = (boxes: Box[]) =>
      boxes.filter((b) => b.color === shirt || b.color === shade(shirt, 0.85))
    for (const combo of combos) expect(body(seated(combo))).toEqual(body(seated({})))
  })

  it('makes every look different from every other in what is drawn, except a bun under a cap, which cannot be seen', () => {
    const seen = new Set<string>()
    for (const combo of combos) {
      if (combo.style === 'bun' && combo.accessory === 'cap') continue
      seen.add(JSON.stringify(seated(combo)))
    }
    expect(seen.size).toBe(combos.length - 1)
    expect(seated({ style: 'bun', accessory: 'cap' })).toEqual(
      seated({ style: 'short', accessory: 'cap' }),
    )
  })
})
