// The strict CSP forbids eval; PixiJS normally compiles shaders with it. This build does not.
import 'pixi.js/unsafe-eval'
import { Application, Container, Graphics, Polygon, Text, type TextOptions } from 'pixi.js'
import type { AgentView } from '@shared/agents/view'
import { bubbleFor, type BubbleModel, type Trip } from './bubble'
import { Director, type Assignment, type Subject } from './director'
import {
  actionForKey,
  clampCamera,
  fitCamera,
  followStep,
  labelScale,
  MAX_ZOOM,
  MIN_ZOOM,
  panBy,
  ROLE_MIN_SCALE,
  transformOf,
  wheelFactor,
  zoomAt,
  type Camera,
} from './camera'
import {
  HEAD_ANCHOR,
  LED_BOX,
  NAME_ANCHOR,
  STATION_DEPTH,
  STATION_WIDTH,
  benchBoxes,
  benchScreens,
  boardBoxes,
  boardCardBox,
  chairBoxes,
  deskBoxes,
  deskPaperBoxes,
  flyingBoxes,
  glassBoxes,
  inboxBoxes,
  inboxCardBoxes,
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
  type Held,
} from './furniture'
import { FlightQueue, flightPoint, type Endpoint, type Flight, type Point3 } from './handoffs'
import {
  boxFaces,
  hexToNumber,
  project,
  rectBounds,
  shade,
  tilePolygon,
  unionBounds,
  type Bounds,
  type Box,
  type Point,
} from './iso'
import {
  WALL_HEIGHT,
  assignDesks,
  buildOffice,
  depthOf,
  groupWalls,
  seatPoint,
  stationRect,
  type DeskSlot,
  type OfficeMap,
  type Place,
  type PlaceKind,
  type Point2,
  type Rect,
  type Room,
  type RoomKind,
} from './map'
import { buildNavGrid, reachableFrom, seatExit, type NavGrid } from './nav'
import { BREAK_KINDS, Life, type BreakKind } from './life'
import { NoteBoard, type Note } from './talk'
import { LED_COLORS, poseFor, type Pose } from './pose'
import {
  advance,
  depthOfWalker,
  facingOf,
  gaitPhase,
  pathHome,
  pathTo,
  seatedAt,
  standingAt,
  startWalk,
  type Home,
  type Walker,
} from './walker'
import {
  EMPTY_SIGNALS,
  benchLabel,
  boardLabel,
  inboxLabel,
  inboxTint,
  type BenchState,
  type OfficeSignals,
} from './work'

export interface SceneEmployee {
  id: string
  name: string
  role: string
  /** Shirt colour, #rrggbb. */
  color: string
  /** Managers sit in a cabin, and their team sits together. */
  isManager?: boolean
  reportsTo?: string | null
}

/** What the view controls need to know about the camera. */
export interface CameraState {
  /** 1 shows the whole office. */
  zoom: number
  /** The whole office is in view, as it is until the person moves the camera. */
  fitted: boolean
  following: boolean
  canZoomIn: boolean
  canZoomOut: boolean
}

export interface SceneCallbacks {
  onSelect(id: string): void
  onCamera(state: CameraState): void
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const ACCENT = 0xe8893a
const SURFACE = 0x1e1a17

const FLOOR_A = 0x7a5c44
const FLOOR_B = 0x86664c
/** The two tones of each kind of room's floor, so a room can be told from the next. */
const FLOORS: Record<RoomKind, readonly [number, number]> = {
  open: [FLOOR_A, FLOOR_B],
  pantry: [0xcfc6b0, 0xdbd2bc],
  cabin: [0x5f6d64, 0x69776e],
  yours: [0x6b5f72, 0x756a7c],
  lab: [0x6f6a5c, 0x7b7566],
  meeting: [0x55627a, 0x5f6d86],
  reading: [0x4f5a6e, 0x596479],
}
const WALL = 0xeadcbf
const SLAB = 0x4a382b
/** How far the pointer must move before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD = 4

function drawBox(g: Graphics, box: Box): void {
  const faces = boxFaces(box)
  const alpha = box.alpha ?? 1
  g.poly(faces.left).fill({ color: shade(box.color, 0.82), alpha })
  g.poly(faces.right).fill({ color: shade(box.color, 0.66), alpha })
  g.poly(faces.top).fill({ color: box.color, alpha })
}

function at(box: Box, slot: { x: number; y: number }): Box {
  return { ...box, x: box.x + slot.x, y: box.y + slot.y }
}

/** Windows on the tall walls: a span along the wall and how high. */
const BACK_WINDOWS: ReadonlyArray<{ from: number; to: number; z: number; h: number }> = [
  // Above the tea counter.
  { from: 1.0, to: 3.4, z: 1.5, h: 1.0 },
  { from: 7.0, to: 10.4, z: 1.15, h: 1.15 },
  { from: 11.6, to: 15.0, z: 1.15, h: 1.15 },
  // Above the QA bench, high enough to clear its screens.
  { from: 17.2, to: 19.6, z: 1.45, h: 1.0 },
]
const SIDE_WINDOWS: ReadonlyArray<{ from: number; to: number }> = [
  { from: 1.2, to: 3.4 },
  { from: 6.4, to: 8.6 },
  { from: 9.8, to: 12.0 },
]

/** The floor, the tall walls on the two far sides, and their windows. Drawn when the plan changes. */
function drawFloor(g: Graphics, map: OfficeMap): void {
  for (const room of map.rooms) {
    const { x, y, w, d } = room.rect
    // Slab edge, so the room has thickness where it meets the void.
    drawBox(g, { x, y, z: -0.3, w, d, h: 0.3, color: SLAB })
  }
  for (const room of map.rooms) {
    const { x, y, w, d } = room.rect
    const [a, b] = FLOORS[room.kind]
    for (let tx = 0; tx < w; tx++) {
      for (let ty = 0; ty < d; ty++) {
        g.poly(tilePolygon(x + tx, y + ty)).fill((tx + ty) % 2 === 0 ? a : b)
      }
    }
  }

  const [back, side] = map.outerWalls
  if (back) drawBox(g, { ...back, z: 0, h: WALL_HEIGHT, color: WALL })
  if (side) drawBox(g, { ...side, z: 0, h: WALL_HEIGHT, color: WALL })
  // Skirting boards.
  if (back) drawBox(g, { x: 0, y: 0, z: 0, w: back.w, d: 0.05, h: 0.18, color: 0x8b6f52 })
  if (side) drawBox(g, { x: 0, y: 0, z: 0, w: 0.05, d: side.d, h: 0.18, color: 0x8b6f52 })

  // Windows, laid on the inner wall faces.
  for (const win of BACK_WINDOWS) {
    if (back && win.to <= back.w) {
      drawBox(g, {
        x: win.from,
        y: -0.01,
        z: win.z,
        w: win.to - win.from,
        d: 0.01,
        h: win.h,
        color: 0x9ccfe8,
      })
    }
  }
  for (const win of SIDE_WINDOWS) {
    if (side && win.to <= side.d) {
      drawBox(g, {
        x: -0.01,
        y: win.from,
        z: 1.15,
        w: 0.01,
        d: win.to - win.from,
        h: 1.15,
        color: 0x9ccfe8,
      })
    }
  }
}

/** The kinds of place that get a name tag; the rest are named by their room, or are just furniture. */
const LABELLED: ReadonlySet<PlaceKind> = new Set([
  'board',
  'qa',
  'inbox',
  'reading',
  'tea',
  'snacks',
])

/** Where a place's name goes: above it, on the wall side of it. World coordinates and a height. */
function labelAnchor(place: Place, all: readonly Place[]): { x: number; y: number; z: number } {
  const f = place.footprint
  switch (place.kind) {
    case 'board':
      return { x: f.x + f.w / 2, y: f.y + 0.1, z: 2.5 }
    case 'qa':
      return { x: f.x + f.w / 2, y: f.y + 0.4, z: 1.55 }
    case 'inbox':
      return { x: f.x + f.w / 2, y: f.y + 0.8, z: 1.3 }
    case 'tea':
      return { x: f.x + f.w / 2, y: f.y + 0.4, z: 1.9 }
    case 'snacks':
      return { x: f.x + f.w / 2, y: f.y + 0.3, z: 2.05 }
    case 'reading': {
      // One name for the whole alcove, centred over both desks.
      const desks = all.filter((p) => p.kind === 'reading')
      const minX = Math.min(...desks.map((p) => p.footprint.x))
      const maxX = Math.max(...desks.map((p) => p.footprint.x + p.footprint.w))
      return { x: (minX + maxX) / 2, y: f.y + 0.1, z: 1.95 }
    }
    default:
      return { x: f.x + f.w / 2, y: f.y + f.d / 2, z: 1.4 }
  }
}

/** A small name tag for a shared place, drawn in the overlay so its text stays crisp. */
class PlaceLabel {
  readonly view = new Container()
  private readonly label: Text
  private readonly bg = new Graphics()
  private text: string

  constructor(
    text: string,
    readonly anchor: { x: number; y: number; z: number },
    resolution: number,
    /** Which kind of place it names, when what it says changes with the work there. */
    readonly kind: PlaceKind | null = null,
  ) {
    this.text = text
    this.label = new Text({
      text,
      style: { fontFamily: FONT, fontSize: 10.5, fill: 0xf3ead8, fontWeight: '600' },
      resolution,
    })
    this.label.anchor.set(0.5, 0.5)
    this.view.addChild(this.bg, this.label)
    this.view.eventMode = 'none'
    this.layout()
  }

  /** Say something else, as when the board's cards change. */
  setText(text: string): void {
    if (text === this.text) return
    this.text = text
    this.label.text = text
    this.layout()
  }

  private layout(): void {
    const padX = 8
    const height = 19
    this.bg
      .clear()
      .roundRect(-this.label.width / 2 - padX, -height, this.label.width + padX * 2, height, 7)
      .fill({ color: SURFACE, alpha: 0.86 })
    this.label.position.set(0, -height / 2)
  }
}

/** A small rounded status bubble with a tail, drawn above an employee's head. */
class Bubble {
  readonly view = new Container()
  private readonly bg = new Graphics()
  private readonly label = new Text(this.textOptions('', 12.5, 0xf3ead8, '700'))
  private readonly detail = new Text(this.textOptions('', 11, 0xa39683, '400'))
  private readonly tag = new Text(this.textOptions('', 10, ACCENT, '600'))
  private key = ''
  private pulse = false
  private base = 1
  /** How far it reaches above the head, unscaled, including its tail. */
  extent = 0

  constructor(private readonly resolution: number) {
    this.view.addChild(this.bg, this.label, this.detail, this.tag)
  }

  private textOptions(text: string, size: number, fill: number, weight: string): TextOptions {
    return {
      text,
      style: { fontFamily: FONT, fontSize: size, fill, fontWeight: weight as '400' },
      resolution: this.resolution,
    }
  }

  update(model: BubbleModel, dot: number): void {
    const key = JSON.stringify([
      model.label,
      model.detail,
      model.tone,
      model.provenance,
      model.caution,
      model.simulated,
      dot,
    ])
    if (key === this.key) return
    this.key = key
    this.pulse = model.tone === 'wait' || model.tone === 'error'

    this.label.text = model.label
    this.detail.text = model.detail ?? ''
    this.detail.visible = model.detail !== null
    // Small notes on the state: a restriction from the circuit breaker, whether the state is our
    // inference or demo data, and whether they are away for simulated office life. Any can apply.
    const notes = [model.caution, model.provenance, model.simulated ? 'simulated' : null].filter(
      (note) => note !== null,
    )
    this.tag.text = notes.join(' · ')
    this.tag.visible = notes.length > 0

    const padX = 10
    const padY = 7
    const dotSpace = 16
    const row1 = dotSpace + this.label.width + (notes.length > 0 ? 8 + this.tag.width : 0)
    const width = Math.max(row1, model.detail ? this.detail.width : 0) + padX * 2
    const height = padY * 2 + 16 + (model.detail ? 15 : 0)
    const tail = 7
    this.extent = height + tail
    const tone: Record<BubbleModel['tone'], number> = {
      off: 0x6f675e,
      idle: 0x8ab4e8,
      busy: dot,
      wait: 0xffb547,
      error: 0xff5a4d,
    }

    this.bg.clear()
    this.bg
      .roundRect(-width / 2, -height - tail, width, height, 9)
      .fill({ color: SURFACE, alpha: 0.94 })
      .stroke({ width: 1.5, color: tone[model.tone], alpha: 0.75 })
    this.bg.poly([-6, -tail, 6, -tail, 0, 0]).fill({ color: SURFACE, alpha: 0.94 })
    this.bg.circle(-width / 2 + padX + 4, -height - tail + padY + 8, 4).fill(dot)

    this.label.position.set(-width / 2 + padX + dotSpace, -height - tail + padY + 1)
    this.tag.position.set(width / 2 - padX - this.tag.width, -height - tail + padY + 3)
    this.detail.position.set(-width / 2 + padX, -height - tail + padY + 19)
  }

  /** How big the whole bubble is drawn, as a share of full size. */
  setScale(base: number): void {
    this.base = base
  }

  tick(time: number): void {
    const s = this.pulse ? 1 + 0.035 * Math.sin(time * 6) : 1
    this.view.scale.set(s * this.base)
  }
}

/** What a note chip shows: text, and whether it is simulated (the empty "…" of a chat). */
interface ChipModel {
  text: string
  simulated: boolean
}

/**
 * A small note above an employee's status bubble: the real subject of a message they are part of,
 * or the empty "…" of simulated chat, which is marked as simulated and never has words in it.
 */
class NoteChip {
  readonly view = new Container()
  private readonly bg = new Graphics()
  private readonly label: Text
  private readonly tag: Text
  private key = ''

  constructor(resolution: number) {
    this.label = new Text({
      text: '',
      style: { fontFamily: FONT, fontSize: 11.5, fill: 0xf3ead8, fontWeight: '600' },
      resolution,
    })
    this.tag = new Text({
      text: 'simulated',
      style: { fontFamily: FONT, fontSize: 9.5, fill: ACCENT, fontWeight: '600' },
      resolution,
    })
    this.view.addChild(this.bg, this.label, this.tag)
    this.view.eventMode = 'none'
    this.view.visible = false
  }

  set(model: ChipModel | null): void {
    if (!model) {
      this.view.visible = false
      this.key = ''
      return
    }
    this.view.visible = true
    const key = `${model.simulated}|${model.text}`
    if (key === this.key) return
    this.key = key

    const padX = 9
    const height = 22
    const tail = 6
    this.label.text = model.text
    this.label.style.fontSize = model.simulated ? 17 : 11.5
    this.label.style.fill = model.simulated ? 0x2b2622 : 0xf3ead8
    this.tag.visible = model.simulated
    const width = padX * 2 + this.label.width + (model.simulated ? 6 + this.tag.width : 0)

    this.bg.clear()
    this.bg
      .roundRect(-width / 2, -height - tail, width, height, 9)
      .fill({ color: model.simulated ? 0xf3ead8 : SURFACE, alpha: 0.95 })
      .stroke({ width: 1.5, color: model.simulated ? ACCENT : 0x8ab4e8, alpha: 0.8 })
    this.bg
      .poly([-5, -tail, 5, -tail, 0, 0])
      .fill({ color: model.simulated ? 0xf3ead8 : SURFACE, alpha: 0.95 })
    this.label.position.set(-width / 2 + padX, -height - tail + (model.simulated ? -1 : 3.5))
    this.tag.position.set(width / 2 - padX - this.tag.width, -height - tail + 6)
  }
}

/** One employee's workstation and the little person at it. */
class Desk {
  readonly container = new Container()
  readonly bubble: Bubble
  readonly chip: NoteChip
  readonly nameLabel: Text
  readonly roleLabel: Text
  private readonly selection = new Graphics()
  private readonly rugGfx = new Graphics()
  private readonly back = new Graphics()
  private readonly person = new Graphics()
  private readonly front = new Graphics()
  private readonly fx = new Graphics()
  private view: AgentView | undefined
  private readonly shirt: number
  /** Their person is not at the desk: walking, or standing at a shared place. */
  private away = false
  /** The kind of place they have gone to, if they are on their way to one or there. */
  private awayAt: PlaceKind | null = null
  /** Where their head is while they are away, so the bubble goes with them. */
  private headAt: { x: number; y: number; z: number } | null = null
  /** Why they are away: our reading of their agent, a recorded fact, or simulated office life. */
  private trip: Trip = 'inferred'
  /** A paper on the desk, while they have a task in hand. */
  private paper = false

  constructor(
    readonly employee: SceneEmployee,
    readonly slot: DeskSlot,
    resolution: number,
    onSelect: (id: string) => void,
  ) {
    this.shirt = hexToNumber(employee.color)
    this.container.zIndex = depthOf(stationRect(slot))
    this.container.addChild(
      this.selection,
      this.rugGfx,
      this.back,
      this.person,
      this.front,
      this.fx,
    )

    drawBox(this.rugGfx, at(rug(this.shirt), slot))
    for (const box of chairBoxes()) drawBox(this.back, at(box, slot))
    this.drawFront()

    this.bubble = new Bubble(resolution)
    this.chip = new NoteChip(resolution)
    this.nameLabel = new Text({
      text: employee.name,
      style: { fontFamily: FONT, fontSize: 13, fill: 0xf3ead8, fontWeight: '700' },
      resolution,
    })
    this.roleLabel = new Text({
      text: employee.role,
      style: { fontFamily: FONT, fontSize: 10.5, fill: 0xd9cdb8, fontWeight: '400' },
      resolution,
    })
    this.nameLabel.anchor.set(0.5, 0)
    this.roleLabel.anchor.set(0.5, 0)

    // Clicking anywhere on the station selects the employee.
    const margin = 0.3
    const p = (x: number, y: number, z: number) => project(slot.x + x, slot.y + y, z)
    const corners = [
      p(-margin, -margin, 1.9),
      p(STATION_WIDTH + margin, -margin, 1.9),
      p(STATION_WIDTH + margin, STATION_DEPTH + margin, 0),
      p(-margin, STATION_DEPTH + margin, 0),
    ]
    this.container.hitArea = new Polygon(corners.flatMap((c) => [c.x, c.y]))
    this.container.eventMode = 'static'
    this.container.cursor = 'pointer'
    this.container.on('pointertap', () => onSelect(employee.id))
  }

  setView(view: AgentView | undefined): void {
    this.view = view
  }

  /** Say whether their person is away from the desk, and if so where they have gone. */
  setTravel(travel: {
    away: boolean
    at: PlaceKind | null
    head: { x: number; y: number; z: number } | null
    trip: Trip
  }): void {
    this.away = travel.away
    this.awayAt = travel.at
    this.headAt = travel.head
    this.trip = travel.trip
  }

  /** The desk, with a paper on it while their owner has a task in hand. */
  private drawFront(): void {
    this.front.clear()
    for (const box of deskBoxes()) drawBox(this.front, at(box, this.slot))
    if (this.paper) for (const box of deskPaperBoxes()) drawBox(this.front, at(box, this.slot))
  }

  setPaper(on: boolean): void {
    if (on === this.paper) return
    this.paper = on
    this.drawFront()
  }

  /** The note over their status bubble, or nothing. */
  setNote(model: ChipModel | null): void {
    this.chip.set(model)
  }

  /** Release everything this desk created, including the labels that live in the overlay. */
  dispose(): void {
    this.container.destroy({ children: true })
    this.bubble.view.destroy({ children: true })
    this.chip.view.destroy({ children: true })
    this.nameLabel.destroy()
    this.roleLabel.destroy()
  }

  setSelected(selected: boolean): void {
    this.selection.clear()
    if (!selected) return
    const poly = tilePolygon(
      this.slot.x - 0.35,
      this.slot.y - 0.3,
      STATION_WIDTH + 0.7,
      STATION_DEPTH + 0.75,
    )
    this.selection
      .poly(poly)
      .fill({ color: ACCENT, alpha: 0.22 })
      .stroke({ width: 2, color: ACCENT, alpha: 0.9 })
  }

  /** Redraw the parts that move, and refresh the bubble. */
  tick(time: number): void {
    const state = this.view?.state ?? 'offline'
    const pose = poseFor(state, time)

    // Nobody is in the chair while they are away, and the monitor goes on showing the state.
    this.person.clear()
    if (!this.away) {
      for (const box of personBoxes(pose, this.shirt)) drawBox(this.person, at(box, this.slot))
    }

    this.fx.clear()
    const led = at(LED_BOX, this.slot)
    const ledColor = pose.ledOn ? LED_COLORS[pose.led] : LED_COLORS.off
    if (pose.ledOn && pose.led !== 'off') {
      const c = project(led.x + led.w / 2, led.y + led.d, led.z + led.h / 2)
      this.fx
        .ellipse(c.x, c.y, 9, 6)
        .fill({ color: LED_COLORS[pose.led], alpha: 0.28 * pose.glow + 0.08 })
    }
    drawBox(this.fx, { ...led, color: ledColor })

    const model = bubbleFor(this.view, this.awayAt, this.trip)
    this.bubble.update(model, LED_COLORS[poseFor(state, 0).led])
    this.bubble.tick(time)
  }

  headScreen(): { x: number; y: number } {
    if (this.away && this.headAt) return project(this.headAt.x, this.headAt.y, this.headAt.z)
    return project(this.slot.x + HEAD_ANCHOR.x, this.slot.y + HEAD_ANCHOR.y, HEAD_ANCHOR.z)
  }

  /** The middle of the workstation, for the camera to follow. */
  centreScreen(): { x: number; y: number } {
    return project(this.slot.x + STATION_WIDTH / 2, this.slot.y + STATION_DEPTH / 2, 0.6)
  }

  nameScreen(): { x: number; y: number } {
    return project(this.slot.x + NAME_ANCHOR.x, this.slot.y + NAME_ANCHOR.y, NAME_ANCHOR.z)
  }
}

/**
 * A reading desk: a workstation nobody owns, where someone doing an independent review sits. It is
 * laid out like an employee's own desk (chair, person, then desk over their lap), with nobody in it
 * until a reviewer has walked there.
 */
class ReadingDesk {
  readonly container = new Container()
  private readonly person = new Graphics()
  private readonly fx = new Graphics()

  constructor(readonly slot: DeskSlot) {
    const back = new Graphics()
    const front = new Graphics()
    drawBox(back, at(rug(0x5b6b80), slot))
    for (const box of chairBoxes()) drawBox(back, at(box, slot))
    for (const box of deskBoxes()) drawBox(front, at(box, slot))
    this.container.zIndex = depthOf(stationRect(slot))
    this.container.addChild(back, this.person, front, this.fx)
    this.setSitter(null)
  }

  /** Who is sitting here, in what pose: nobody if null. The monitor's light shows their state. */
  setSitter(sitter: { shirt: number; pose: Pose } | null): void {
    this.person.clear()
    this.fx.clear()
    const led = at(LED_BOX, this.slot)
    if (!sitter) {
      drawBox(this.fx, { ...led, color: LED_COLORS.off })
      return
    }
    for (const box of personBoxes(sitter.pose, sitter.shirt)) {
      drawBox(this.person, at(box, this.slot))
    }
    drawBox(this.fx, {
      ...led,
      color: sitter.pose.ledOn ? LED_COLORS[sitter.pose.led] : LED_COLORS.off,
    })
  }
}

/**
 * A person on their feet: walking, or standing at a shared place. Drawn only while they are away
 * from their desk; while seated, the desk draws them.
 */
class WalkerView {
  readonly g = new Graphics()

  constructor(
    id: string,
    private readonly shirt: number,
    onSelect: (id: string) => void,
  ) {
    this.g.visible = false
    this.g.eventMode = 'static'
    this.g.cursor = 'pointer'
    this.g.on('pointertap', () => onSelect(id))
  }

  draw(walker: Walker, holding: Held | null): void {
    const away = walker.mode !== 'seated'
    this.g.visible = away
    if (!away) return
    this.g.zIndex = depthOfWalker(walker)
    this.g.clear()
    const feet = project(walker.x, walker.y, 0)
    this.g.ellipse(feet.x, feet.y, 11, 5.5).fill({ color: 0x000000, alpha: 0.25 })
    const boxes = walkerBoxes(
      { x: walker.x, y: walker.y },
      walker.facing,
      gaitPhase(walker),
      walker.mode === 'walking',
      this.shirt,
      holding,
    )
    for (const box of boxes) drawBox(this.g, box)
  }

  dispose(): void {
    this.g.destroy()
  }
}

/** Where one employee's person is, and what they were last told to do. */
interface Traveller {
  walker: Walker
  home: Home
  slot: DeskSlot
  color: string
  view: WalkerView
  /** What they were last told: `desk`, or a place and spot. Only a change starts a new walk. */
  commanded: string
  target: Assignment | null
  /** The reading desk they are going to sit at (or are sitting at), if that is where they were sent. */
  chair: { placeId: string; slot: DeskSlot; home: Home } | null
  /** Why they are where they are going: our reading of their agent, a recorded fact, or simulated life. */
  trip: Trip
  /** What they carry back from the pantry, until they are back at their desk. */
  holding: Held | null
}

/** The colours the bench's screens light up with while the checks run, and after. */
const BENCH_COLORS: Record<Exclude<BenchState, 'dark'>, number> = {
  running: 0xffb547,
  passed: 0x5fd38a,
  failed: 0xff6a5c,
}

/**
 * The isometric voxel office. It draws nothing on its own authority: what each employee is
 * doing comes from their `AgentView`, which comes from real events.
 *
 * The floor plan comes from `buildOffice`, and grows with the team. Everything that stands on the
 * floor is one item in a single depth-sorted layer, so a person, a desk and a wall are always drawn
 * in the right order however they are arranged. The camera (drag to move, wheel to zoom, keys, or
 * following someone) is pure maths in `camera.ts`; this class only applies it.
 */
export class OfficeScene {
  private readonly world = new Container()
  private readonly floor = new Graphics()
  private readonly items = new Container()
  private readonly overlay = new Container()
  private readonly flightGfx = new Graphics()
  private readonly deskViews = new Map<string, Desk>()
  /** Things that belong to the current plan, dropped and rebuilt when it changes. */
  private statics: Container[] = []
  private placeLabels: PlaceLabel[] = []
  /** What the board, the inbox and the bench show of the work, redrawn when the work changes. */
  private boardGfx: Graphics | null = null
  private inboxGfx: Graphics | null = null
  private benchGfx: Graphics | null = null
  private signals: OfficeSignals = EMPTY_SIGNALS
  private readingDesks = new Map<string, ReadingDesk>()
  private readonly flightQueue = new FlightQueue()
  /** Real messages, shown for a few seconds over the employees they are between. */
  private readonly noteBoard = new NoteBoard()
  /** The simulated life of the office (tea and snack breaks), and whether it is switched on. */
  private readonly life = new Life()
  private lifeOn = true
  private onBreak = new Map<string, BreakKind>()
  /** Where each flight in the air is going, fixed when it takes off. */
  private readonly routes = new Map<string, { from: Point3; to: Point3 }>()
  private map: OfficeMap = buildOffice()
  /** Furniture for desks nobody sits at, so an empty desk still looks like a desk. */
  private emptyDesks = new Map<string, Graphics>()
  private grid: NavGrid = buildNavGrid(this.map)
  private mainFloor = new Set<number>()
  private director = new Director(this.map.places)
  private readonly travellers = new Map<string, Traveller>()
  private bounds: Bounds
  private camera: Camera
  /** Until the person moves the camera, it keeps the whole office in view as things change. */
  private autoFit = true
  private following = false
  private views: Record<string, AgentView> = {}
  private selected: string | null = null
  private time = 0
  private readonly reducedMotion: boolean
  private readonly resolution: number
  private destroyed = false
  private lastState = ''
  private drag: {
    id: number
    startX: number
    startY: number
    lastX: number
    lastY: number
    moved: boolean
  } | null = null
  /** Whether the press that is ending was a drag, so it is not also taken as a click. */
  private dragged = false

  private readonly observer: ResizeObserver

  private constructor(
    private readonly app: Application,
    host: HTMLElement,
    private readonly callbacks: SceneCallbacks,
  ) {
    this.resolution = Math.max(2, window.devicePixelRatio || 1)
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    this.items.sortableChildren = true
    // Nearer employees' labels sit above farther ones'; the names of places sit under them all.
    this.overlay.sortableChildren = true
    this.world.addChild(this.floor, this.items, this.flightGfx)
    this.app.stage.addChild(this.world, this.overlay)
    this.bounds = this.boundsOf(this.map)
    this.camera = fitCamera(this.bounds)
    this.applyMap(this.map)

    // PixiJS only follows the *window*; the panel also changes size when the roster grows.
    this.observer = new ResizeObserver(() => {
      const width = Math.max(1, host.clientWidth)
      const height = Math.max(1, host.clientHeight)
      if (width !== this.app.screen.width || height !== this.app.screen.height) {
        this.app.renderer.resize(width, height)
      }
    })
    this.observer.observe(host)
    this.app.renderer.on('resize', () => this.onResize())

    const canvas = this.app.canvas
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerEnd)
    canvas.addEventListener('pointercancel', this.onPointerEnd)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.app.renderer.events.cursorStyles['default'] = 'grab'

    this.app.ticker.add((ticker) => {
      const dt = ticker.deltaMS / 1000
      if (!this.reducedMotion) this.time += dt
      this.moveEveryone(dt)
      this.updateFlights()
      if (this.benchGfx) {
        // The screens breathe while the checks run.
        this.benchGfx.alpha =
          this.signals.bench === 'running' ? 0.72 + 0.28 * Math.sin(this.time * 6) : 1
      }
      const said = this.noteBoard.active(Date.now())
      for (const [id, desk] of this.deskViews) {
        const text = said.get(id)
        desk.setNote(text === undefined ? null : { text, simulated: false })
      }
      for (const desk of this.deskViews.values()) desk.tick(this.time)
      this.followSelected(dt)
      this.placeOverlay()
    })
    this.applyCamera()
  }

  static async create(host: HTMLElement, callbacks: SceneCallbacks): Promise<OfficeScene> {
    const app = new Application()
    await app.init({
      background: 0x14110f,
      antialias: true,
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight),
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    })
    host.appendChild(app.canvas)
    return new OfficeScene(app, host, callbacks)
  }

  // ---------- who is in the office ----------

  setEmployees(employees: readonly SceneEmployee[]): void {
    // The office is one plan whatever the team size: people are seated into it.
    const { seated } = assignDesks(employees, this.map)
    const keep = new Set(seated.map((s) => s.employee.id))

    for (const [id, desk] of this.deskViews) {
      if (!keep.has(id)) {
        desk.dispose()
        this.deskViews.delete(id)
      }
    }

    for (const { employee, slot } of seated) {
      const existing = this.deskViews.get(employee.id)
      // A desk is rebuilt when the employee's look changes, or when they move to another desk.
      if (
        existing &&
        existing.slot.x === slot.x &&
        existing.slot.y === slot.y &&
        existing.employee.color === employee.color &&
        existing.employee.name === employee.name &&
        existing.employee.role === employee.role
      ) {
        continue
      }
      existing?.dispose()
      const desk = new Desk(employee, slot, this.resolution, (id) => this.select(id))
      desk.setView(this.views[employee.id])
      desk.setSelected(this.selected === employee.id)
      desk.setPaper(this.signals.holding.includes(employee.id))
      this.deskViews.set(employee.id, desk)
      this.items.addChild(desk.container)
      for (const view of [desk.nameLabel, desk.roleLabel, desk.bubble.view, desk.chip.view]) {
        view.zIndex = 10 + depthOf(stationRect(slot))
        this.overlay.addChild(view)
      }
    }
    this.refreshEmptyDesks()
    this.syncTravellers()
    this.placeOverlay()
  }

  /** Give every desk nobody is sitting at its own furniture, and take it away once someone is. */
  private refreshEmptyDesks(): void {
    const taken = new Set([...this.deskViews.values()].map((d) => `${d.slot.x},${d.slot.y}`))
    for (const slot of [...this.map.desks, ...this.map.cabins]) {
      const key = `${slot.x},${slot.y}`
      const existing = this.emptyDesks.get(key)
      if (taken.has(key)) {
        if (existing) {
          existing.destroy()
          this.emptyDesks.delete(key)
        }
      } else if (!existing) {
        const view = this.emptyStation(slot)
        view.zIndex = depthOf(stationRect(slot))
        this.items.addChild(view)
        this.emptyDesks.set(key, view)
      }
    }
  }

  setViews(views: Record<string, AgentView>): void {
    this.views = views
    for (const [id, desk] of this.deskViews) desk.setView(views[id])
  }

  setSelected(id: string | null): void {
    this.selected = id
    for (const [deskId, desk] of this.deskViews) desk.setSelected(deskId === id)
    if (id === null && this.following) {
      this.following = false
      this.notify()
    }
  }

  /** What the work looks like now: the board's cards, the inbox, the bench, and who holds a task. */
  setSignals(signals: OfficeSignals): void {
    this.signals = signals
    this.drawSignals()
    const holding = new Set(signals.holding)
    for (const [id, desk] of this.deskViews) desk.setPaper(holding.has(id))
  }

  /** Show these notes (the real subject of a message that has just been sent) over their employees. */
  say(notes: readonly Note[]): void {
    this.noteBoard.say(notes, Date.now())
  }

  /** Send a card or an envelope across the office, for a handoff that has just happened. */
  fly(flight: Flight): void {
    // With reduced motion nothing crosses the room: the places already show where the work is.
    if (this.reducedMotion || this.destroyed) return
    this.flightQueue.push(flight, performance.now())
  }

  /**
   * Switch the office's simulated life (tea and snack breaks while an agent is idle) on or off.
   * Off calls everyone on a break back to their desk.
   */
  setLife(on: boolean): void {
    this.lifeOn = on
  }

  /** A click on a desk selects it, unless the press was really a drag of the camera. */
  private select(id: string): void {
    if (!this.dragged) this.callbacks.onSelect(id)
  }

  // ---------- the camera ----------

  private viewport(): { width: number; height: number } {
    return { width: this.app.screen.width, height: this.app.screen.height }
  }

  /** Zoom in (`factor` above 1) or out, about the middle of the panel. */
  zoomBy(factor: number): void {
    const { width, height } = this.viewport()
    this.setCamera(
      zoomAt(this.camera, factor, { x: width / 2, y: height / 2 }, this.bounds, this.viewport()),
    )
  }

  /** Move the picture by this many pixels, as a drag does. Moving it by hand stops following. */
  moveBy(dx: number, dy: number): void {
    this.stopFollowing()
    this.setCamera(panBy(this.camera, dx, dy, this.bounds, this.viewport()))
  }

  /** Show the whole office again. */
  fit(): void {
    this.following = false
    this.autoFit = true
    this.camera = fitCamera(this.bounds)
    this.applyCamera()
  }

  /** Keep the selected employee in the middle of the panel (or stop doing that). */
  setFollow(on: boolean): void {
    this.following = on && this.selected !== null
    // Following brings the picture in, so it no longer keeps the whole office in view by itself.
    if (this.following) this.autoFit = false
    this.notify()
  }

  /** Act on a key if it is a camera key. Returns whether it was, so the caller can keep the event. */
  handleKey(key: string): boolean {
    const action = actionForKey(key)
    if (!action) return false
    if (action.kind === 'pan') this.moveBy(action.dx, action.dy)
    else if (action.kind === 'zoom') this.zoomBy(action.factor)
    else if (action.kind === 'fit') this.fit()
    else this.setFollow(!this.following)
    return true
  }

  private stopFollowing(): void {
    if (!this.following) return
    this.following = false
    this.notify()
  }

  private setCamera(next: Camera): void {
    this.camera = next
    this.autoFit = false
    this.applyCamera()
  }

  private followSelected(dt: number): void {
    if (!this.following || this.selected === null) return
    const desk = this.deskViews.get(this.selected)
    if (!desk) return
    // Follow the person, wherever they have walked to, or the desk if they are sitting at it.
    const traveller = this.travellers.get(this.selected)
    const walker = traveller?.walker
    const seat = traveller?.chair?.slot
    const target =
      walker && walker.mode !== 'seated'
        ? project(walker.x, walker.y, 0.8)
        : seat
          ? project(seat.x + STATION_WIDTH / 2, seat.y + STATION_DEPTH / 2, 0.6)
          : desk.centreScreen()
    const next = followStep(this.camera, target, dt, this.reducedMotion, this.bounds)
    if (next.x !== this.camera.x || next.y !== this.camera.y || next.zoom !== this.camera.zoom) {
      this.camera = next
      this.applyCamera()
    }
  }

  private onResize(): void {
    // Keep the whole office in view if that is what was showing; otherwise keep the picture as it is.
    this.camera = this.autoFit ? fitCamera(this.bounds) : clampCamera(this.camera, this.bounds)
    this.applyCamera()
  }

  /** Put the world where the camera says, and tell the controls. */
  private applyCamera(): void {
    const t = transformOf(this.camera, this.bounds, this.viewport())
    this.world.scale.set(t.scale)
    this.world.position.set(t.x, t.y)
    this.placeOverlay()
    this.notify()
  }

  private notify(): void {
    const state: CameraState = {
      zoom: Math.round(this.camera.zoom * 1000) / 1000,
      fitted: this.autoFit && this.camera.zoom === 1,
      following: this.following,
      canZoomIn: this.camera.zoom < MAX_ZOOM - 1e-6,
      canZoomOut: this.camera.zoom > MIN_ZOOM + 1e-6,
    }
    const key = JSON.stringify(state)
    if (key === this.lastState) return
    this.lastState = key
    this.callbacks.onCamera(state)
  }

  // ---------- pointer and wheel ----------

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    this.dragged = false
    this.drag = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
    }
    try {
      // So a drag carries on when the pointer leaves the panel. Not essential, so never fatal.
      this.app.canvas.setPointerCapture(event.pointerId)
    } catch {
      /* the pointer is not one the browser can capture */
    }
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag
    if (!drag || event.pointerId !== drag.id) return
    if (!drag.moved) {
      const far = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY)
      if (far < DRAG_THRESHOLD) return
      drag.moved = true
      this.dragged = true
    }
    const dx = event.clientX - drag.lastX
    const dy = event.clientY - drag.lastY
    drag.lastX = event.clientX
    drag.lastY = event.clientY
    this.moveBy(dx, dy)
  }

  private readonly onPointerEnd = (event: PointerEvent): void => {
    if (this.drag?.id !== event.pointerId) return
    try {
      this.app.canvas.releasePointerCapture(event.pointerId)
    } catch {
      /* it was not captured */
    }
    this.drag = null
  }

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault() // the page behind must not scroll while the office zooms
    const box = this.app.canvas.getBoundingClientRect()
    const anchor = { x: event.clientX - box.left, y: event.clientY - box.top }
    this.setCamera(
      zoomAt(
        this.camera,
        wheelFactor(event.deltaY, event.deltaMode),
        anchor,
        this.bounds,
        this.viewport(),
      ),
    )
  }

  // ---------- the plan ----------

  private boundsOf(map: OfficeMap): Bounds {
    return unionBounds(map.rooms.map((room: Room) => rectBounds(room.rect, WALL_HEIGHT)))
  }

  /** Something that stands on the floor: drawn in depth order among everything else. */
  private addStatic(view: Container, rect: Rect): void {
    view.zIndex = depthOf(rect)
    this.items.addChild(view)
    this.statics.push(view)
  }

  private boxesView(boxes: readonly Box[]): Graphics {
    const g = new Graphics()
    for (const box of boxes) drawBox(g, box)
    return g
  }

  /** Build everything that belongs to the plan: floor, walls, furniture and the names of places. */
  private applyMap(map: OfficeMap): void {
    this.map = map
    for (const view of this.statics) view.destroy({ children: true })
    this.statics = []
    this.readingDesks = new Map()
    this.boardGfx = this.inboxGfx = this.benchGfx = null
    for (const label of this.placeLabels) label.view.destroy({ children: true })
    this.placeLabels = []

    this.floor.clear()
    drawFloor(this.floor, map)

    for (const run of groupWalls(map.walls)) {
      const boxes = run.glass
        ? glassBoxes(run.rect)
        : [partitionBox(run.rect), partitionCap(run.rect)]
      this.addStatic(this.boxesView(boxes), run.rect)
    }
    for (const prop of map.props) {
      this.addStatic(this.boxesView(plantBoxes(prop.footprint)), prop.footprint)
    }
    for (const place of map.places) {
      if (place.kind === 'board') {
        this.addStatic(this.boxesView(boardBoxes(place.footprint)), place.footprint)
        this.boardGfx = this.addWorkLayer(place.footprint)
      } else if (place.kind === 'qa') {
        this.addStatic(this.boxesView(benchBoxes(place.footprint)), place.footprint)
        this.benchGfx = this.addWorkLayer(place.footprint)
      } else if (place.kind === 'inbox') {
        this.addStatic(this.boxesView(inboxBoxes(place.footprint)), place.footprint)
        this.inboxGfx = this.addWorkLayer(place.footprint)
      } else if (place.kind === 'tea') {
        this.addStatic(this.boxesView(teaCounterBoxes(place.footprint)), place.footprint)
      } else if (place.kind === 'snacks') {
        this.addStatic(this.boxesView(snackShelfBoxes(place.footprint)), place.footprint)
      } else if (place.kind === 'chat') {
        this.addStatic(
          this.boxesView(pantryTableBoxes(place.footprint, place.slots)),
          place.footprint,
        )
      } else if (place.kind === 'meeting') {
        this.addStatic(
          this.boxesView(meetingTableBoxes(place.footprint, place.slots)),
          place.footprint,
        )
      } else if (place.station) {
        // A reading desk: empty until someone is sent there to review.
        const reading = new ReadingDesk(place.station)
        this.readingDesks.set(place.id, reading)
        this.addStatic(reading.container, stationRect(place.station))
      }
    }

    // One name tag per name: the places that have one, and the rooms that are named (the two reading
    // desks share one).
    const named = new Set<string>()
    const tag = (
      text: string,
      anchor: { x: number; y: number; z: number },
      kind: PlaceKind | null = null,
    ): void => {
      if (named.has(text)) return
      named.add(text)
      const label = new PlaceLabel(text, anchor, this.resolution, kind)
      this.placeLabels.push(label)
      this.overlay.addChild(label.view)
    }
    for (const place of map.places) {
      if (LABELLED.has(place.kind)) tag(place.label, labelAnchor(place, map.places), place.kind)
    }
    for (const r of map.rooms) {
      if (r.label) tag(r.label, { x: r.rect.x + r.rect.w / 2, y: r.rect.y + 0.5, z: 2.3 })
    }

    // Where people can walk in this plan, and who is where in it.
    this.grid = buildNavGrid(map)
    const anchor = map.places[0]?.stand
    this.mainFloor = anchor ? reachableFrom(this.grid, anchor) : new Set()
    this.director.setPlaces(map.places)
    this.syncTravellers(true)
    this.drawSignals()

    this.bounds = this.boundsOf(map)
    this.camera = this.autoFit ? fitCamera(this.bounds) : clampCamera(this.camera, this.bounds)
    this.applyCamera()
  }

  /** A layer drawn on top of a place, for what the work there looks like. Rebuilt with the plan. */
  private addWorkLayer(footprint: Rect): Graphics {
    const g = new Graphics()
    // Just in front of the place itself, so it is drawn over it and behind whoever stands before it.
    g.zIndex = depthOf(footprint) + 0.001
    this.items.addChild(g)
    this.statics.push(g)
    return g
  }

  private placeOfKind(kind: PlaceKind): Place | undefined {
    return this.map.places.find((p) => p.kind === kind)
  }

  /** Draw the board's cards, the inbox tray and the bench's screens from the work as it stands. */
  private drawSignals(): void {
    const { board, inbox, bench } = this.signals
    const boardPlace = this.placeOfKind('board')
    if (this.boardGfx && boardPlace) {
      const g = this.boardGfx
      g.clear()
      board.cards.forEach((card, index) => {
        const tint = card.kind === 'blocked' ? 'warn' : card.kind === 'done' ? 'good' : 'plain'
        drawBox(g, boardCardBox(boardPlace.footprint, index, tint))
      })
    }
    const inboxPlace = this.placeOfKind('inbox')
    if (this.inboxGfx && inboxPlace) {
      const g = this.inboxGfx
      g.clear()
      for (const box of inboxCardBoxes(inboxPlace.footprint, inbox.cards.map(inboxTint))) {
        drawBox(g, box)
      }
    }
    const benchPlace = this.placeOfKind('qa')
    if (this.benchGfx && benchPlace) {
      const g = this.benchGfx
      g.clear()
      // Dark unless Shokuba's own checks are running or have finished on work waiting for you.
      if (bench !== 'dark') {
        for (const screen of benchScreens(benchPlace.footprint)) {
          drawBox(g, { ...screen, color: BENCH_COLORS[bench] })
        }
      }
    }
    for (const label of this.placeLabels) {
      if (label.kind === 'board') label.setText(boardLabel(board))
      else if (label.kind === 'inbox') label.setText(inboxLabel(inbox))
      else if (label.kind === 'qa') label.setText(benchLabel(bench))
    }
  }

  // ---------- work changing hands ----------

  /** Where an endpoint is in the room, at the height a card would be held, or null if it is not there. */
  private pointOf(endpoint: Endpoint): Point3 | null {
    switch (endpoint.at) {
      case 'board': {
        const f = this.placeOfKind('board')?.footprint
        return f ? { x: f.x + f.w / 2, y: f.y + 0.4, z: 1.6 } : null
      }
      case 'inbox': {
        // Over the inbox's pending tray.
        const f = this.placeOfKind('inbox')?.footprint
        return f ? { x: f.x + 0.5, y: f.y + 0.98, z: 0.9 } : null
      }
      case 'desk': {
        const slot = this.deskViews.get(endpoint.id)?.slot
        return slot ? { x: slot.x + 0.32, y: slot.y + 1.12, z: 0.75 } : null
      }
      case 'person': {
        const walker = this.travellers.get(endpoint.id)?.walker
        return walker ? { x: walker.x, y: walker.y, z: 0.95 } : null
      }
    }
  }

  /** Take off whatever is next, and draw everything in the air. */
  private updateFlights(): void {
    const { started, flying } = this.flightQueue.update(performance.now())
    for (const flight of started) {
      const from = this.pointOf(flight.from)
      const to = this.pointOf(flight.to)
      // Nobody at either end (an employee with no desk yet): nothing to show.
      if (from && to) this.routes.set(flight.key, { from, to })
    }
    const g = this.flightGfx
    g.clear()
    const inAir = new Set<string>()
    for (const { flight, progress } of flying) {
      inAir.add(flight.key)
      const route = this.routes.get(flight.key)
      if (!route) continue
      const at = flightPoint(route.from, route.to, progress)
      const ground = project(at.x, at.y, 0)
      g.ellipse(ground.x, ground.y, 9, 4.5).fill({ color: 0x000000, alpha: 0.18 })
      for (const box of flyingBoxes(flight.thing, at, flight.tint)) drawBox(g, box)
    }
    for (const key of this.routes.keys()) if (!inAir.has(key)) this.routes.delete(key)
  }

  // ---------- people walking ----------

  private homeFor(slot: DeskSlot): Home {
    const seat = seatPoint(slot)
    return { seat, exit: seatExit(this.grid, slot, this.mainFloor) ?? seat }
  }

  /** Make sure every desk has a person to move, and nobody without a desk does. */
  private syncTravellers(planChanged = false): void {
    for (const [id, traveller] of this.travellers) {
      if (!this.deskViews.has(id)) {
        traveller.view.dispose()
        this.travellers.delete(id)
      }
    }
    for (const [id, desk] of this.deskViews) {
      const existing = this.travellers.get(id)
      const home = this.homeFor(desk.slot)
      const sameDesk =
        existing &&
        existing.slot.x === desk.slot.x &&
        existing.slot.y === desk.slot.y &&
        existing.color === desk.employee.color
      if (existing && sameDesk) {
        existing.home = home
        // The floor plan changed under them: think again about the way to where they are going.
        if (planChanged) this.command(existing, existing.target, true)
        continue
      }
      existing?.view.dispose()
      const view = new WalkerView(id, hexToNumber(desk.employee.color), (who) => this.select(who))
      this.items.addChild(view.g)
      this.travellers.set(id, {
        walker: seatedAt(home.seat),
        home,
        slot: desk.slot,
        color: desk.employee.color,
        view,
        commanded: 'desk',
        target: null,
        chair: null,
        trip: 'inferred',
        holding: null,
      })
    }
  }

  private spotOf(target: Assignment): { x: number; y: number } | undefined {
    return this.map.places.find((p) => p.id === target.placeId)?.slots[target.slot]
  }

  /** Which way to face at a place: toward it. */
  private facingAt(target: Assignment): 0 | 1 | 2 | 3 {
    const place = this.map.places.find((p) => p.id === target.placeId)
    const spot = place?.slots[target.slot]
    if (!place || !spot) return 0
    const f = place.footprint
    return facingOf(f.x + f.w / 2 - spot.x, f.y + f.d / 2 - spot.y, 0)
  }

  /** Where someone sits at a reading desk, and where they step out to. */
  private chairHome(station: DeskSlot): Home {
    const seat = seatPoint(station)
    return { seat, exit: seatExit(this.grid, station, this.mainFloor) ?? seat }
  }

  /**
   * Tell someone where to be. A change of orders starts a walk from wherever they are; `snap` puts
   * them there at once, for someone seen for the first time or who has nobody to walk for. A place
   * with a desk (a reading desk) is somewhere to sit; any other place is somewhere to stand.
   */
  private command(traveller: Traveller, target: Assignment | null, snap: boolean): void {
    const spot = target ? this.spotOf(target) : undefined
    const place = target && spot ? target : null
    const station = place ? this.map.places.find((p) => p.id === place.placeId)?.station : undefined
    const chair =
      place && station
        ? { placeId: place.placeId, slot: station, home: this.chairHome(station) }
        : null
    // If they are sitting in a chair that is not their own, they step out of it first.
    const from =
      traveller.walker.mode === 'seated' && traveller.chair ? traveller.chair.home : traveller.home
    traveller.commanded = place ? `${place.placeId}:${place.slot}` : 'desk'
    traveller.target = place
    traveller.chair = chair

    if (!snap) {
      let path: Point2[] | null
      if (chair) {
        const there = pathTo(this.grid, traveller.walker, from, chair.home.exit)
        path = there ? [...there, chair.home.seat] : null
      } else if (spot) {
        path = pathTo(this.grid, traveller.walker, from, spot)
      } else {
        path = pathHome(this.grid, traveller.walker, traveller.home, from)
      }
      if (path) {
        traveller.walker = startWalk(
          traveller.walker,
          path,
          place && !chair ? { kind: 'stand', facing: this.facingAt(place) } : { kind: 'sit' },
        )
        return
      }
      // No way there (which the plan's tests rule out): appear there rather than be stuck.
    }
    traveller.walker = chair
      ? seatedAt(chair.home.seat)
      : place && spot
        ? standingAt(spot, this.facingAt(place))
        : seatedAt(traveller.home.seat)
  }

  /** Ask the director who should be where, send people that way, and move them on. */
  private moveEveryone(dt: number): void {
    const now = Date.now()
    const reviewing = new Set(this.signals.reviewing)
    const people = [...this.deskViews.keys()].map((id) => {
      const view = this.views[id]
      const since = view ? Date.parse(view.since) : NaN
      return {
        id,
        state: view?.state ?? ('offline' as const),
        since: Number.isFinite(since) ? since : now,
      }
    })

    // Simulated life: who is on a tea or snack break, decided from the same states the director sees.
    // It never applies while their agent is working or they have a review to do, and not at all with
    // reduced motion or when it is switched off.
    const arrived = new Set<string>()
    for (const [id, traveller] of this.travellers) {
      const kind = traveller.target?.kind
      if (traveller.walker.mode === 'standing' && kind && BREAK_KINDS.some((b) => b === kind)) {
        arrived.add(id)
      }
    }
    this.onBreak = this.life.update({
      now,
      enabled: this.lifeOn && !this.reducedMotion,
      subjects: people.map((p) => ({ ...p, busy: reviewing.has(p.id) })),
      arrived,
      open: { tea: this.director.openSpots('tea'), snacks: this.director.openSpots('snacks') },
    })

    const subjects: Subject[] = people.map((p) => {
      // Doing an independent review is a recorded fact, and it is done at a reading desk.
      const errand = reviewing.has(p.id) ? ('reading' as const) : this.onBreak.get(p.id)
      return { ...p, ...(errand ? { errand } : {}) }
    })
    const decisions = this.director.update(now, subjects, { reducedMotion: this.reducedMotion })

    const sitters = new Map<string, { shirt: number; pose: Pose }>()
    for (const [id, decision] of decisions) {
      const traveller = this.travellers.get(id)
      const desk = this.deskViews.get(id)
      if (!traveller || !desk) continue
      const key = decision.target ? `${decision.target.placeId}:${decision.target.slot}` : 'desk'
      if (decision.first || decision.absent) {
        this.command(traveller, decision.target, true)
      } else if (key !== traveller.commanded) {
        this.command(traveller, decision.target, false)
      }
      // Never more than a moment's worth, so coming back to a hidden window does not make anyone leap.
      traveller.walker = advance(traveller.walker, Math.min(dt, 0.25))

      // Someone at the tea counter holds a cup, at the snack shelf a snack, and carries it back.
      const kind = traveller.target?.kind
      if (traveller.walker.mode === 'seated') traveller.holding = null
      else if (traveller.walker.mode === 'standing' && kind === 'tea') traveller.holding = 'cup'
      else if (traveller.walker.mode === 'standing' && kind === 'snacks')
        traveller.holding = 'snack'
      traveller.view.draw(traveller.walker, traveller.holding)

      traveller.trip =
        kind === 'reading' && reviewing.has(id)
          ? 'recorded'
          : kind && this.onBreak.get(id) === kind
            ? 'simulated'
            : 'inferred'

      const seat = traveller.walker.mode === 'seated' ? traveller.chair : null
      if (seat) {
        sitters.set(seat.placeId, {
          shirt: hexToNumber(traveller.color),
          pose: poseFor(this.views[id]?.state ?? 'offline', this.time),
        })
      }
      const walking = traveller.walker.mode !== 'seated'
      desk.setTravel({
        away: walking || seat !== null,
        at: traveller.target?.kind ?? null,
        head: walking
          ? { x: traveller.walker.x, y: traveller.walker.y, z: 1.75 }
          : seat
            ? { x: seat.slot.x + HEAD_ANCHOR.x, y: seat.slot.y + HEAD_ANCHOR.y, z: HEAD_ANCHOR.z }
            : null,
        trip: traveller.trip,
      })
    }
    for (const [placeId, reading] of this.readingDesks)
      reading.setSitter(sitters.get(placeId) ?? null)
  }

  /** A workstation with nobody at it: a reading desk, waiting. */
  private emptyStation(slot: DeskSlot): Graphics {
    const g = new Graphics()
    drawBox(g, at(rug(0x5b6b80), slot))
    for (const box of chairBoxes()) drawBox(g, at(box, slot))
    for (const box of deskBoxes()) drawBox(g, at(box, slot))
    drawBox(g, { ...at(LED_BOX, slot), color: LED_COLORS.off })
    return g
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.observer.disconnect()
    const canvas = this.app.canvas
    canvas.removeEventListener('pointerdown', this.onPointerDown)
    canvas.removeEventListener('pointermove', this.onPointerMove)
    canvas.removeEventListener('pointerup', this.onPointerEnd)
    canvas.removeEventListener('pointercancel', this.onPointerEnd)
    canvas.removeEventListener('wheel', this.onWheel)
    this.app.destroy({ removeView: true }, { children: true })
  }

  /**
   * Labels live outside the scaled world so their text stays a constant, crisp size however
   * small the room is drawn. This maps each anchor from world to screen.
   */
  private placeOverlay(): void {
    const s = this.world.scale.x
    const { x: ox, y: oy } = this.world.position
    const place = (p: Point): Point => ({ x: ox + p.x * s, y: oy + p.y * s })
    const k = labelScale(s)
    for (const desk of this.deskViews.values()) {
      const head = place(desk.headScreen())
      desk.bubble.view.position.set(head.x, head.y)
      desk.bubble.setScale(k)
      desk.chip.view.position.set(head.x, head.y - (desk.bubble.extent + 4) * k)
      desk.chip.view.scale.set(k)
      const name = place(desk.nameScreen())
      desk.nameLabel.position.set(name.x, name.y)
      desk.nameLabel.scale.set(k)
      desk.roleLabel.position.set(name.x, name.y + 16 * k)
      desk.roleLabel.scale.set(k)
      desk.roleLabel.visible = s >= ROLE_MIN_SCALE
    }
    for (const label of this.placeLabels) {
      const p = place(project(label.anchor.x, label.anchor.y, label.anchor.z))
      label.view.position.set(p.x, p.y)
      label.view.scale.set(k)
    }
  }
}
