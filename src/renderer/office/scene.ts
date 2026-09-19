// The strict CSP forbids eval; PixiJS normally compiles shaders with it. This build does not.
import 'pixi.js/unsafe-eval'
import { Application, Container, Graphics, Polygon, Text, type TextOptions } from 'pixi.js'
import type { AgentView } from '@shared/agents/view'
import { bubbleFor, type BubbleModel } from './bubble'
import {
  HEAD_ANCHOR,
  LED_BOX,
  NAME_ANCHOR,
  STATION_DEPTH,
  STATION_WIDTH,
  chairBoxes,
  deskBoxes,
  personBoxes,
  rug,
} from './furniture'
import {
  boxFaces,
  fitToViewport,
  hexToNumber,
  project,
  roomBounds,
  shade,
  tilePolygon,
  type Box,
} from './iso'
import { ROOM_DEPTH, ROOM_WIDTH, WALL_HEIGHT, assignDesks, type DeskSlot } from './layout'
import { LED_COLORS, poseFor } from './pose'

export interface SceneEmployee {
  id: string
  name: string
  role: string
  /** Shirt colour, #rrggbb. */
  color: string
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const ACCENT = 0xe8893a
const SURFACE = 0x1e1a17

const FLOOR_A = 0x7a5c44
const FLOOR_B = 0x86664c
const WALL = 0xeadcbf

function drawBox(g: Graphics, box: Box): void {
  const faces = boxFaces(box)
  g.poly(faces.left).fill(shade(box.color, 0.82))
  g.poly(faces.right).fill(shade(box.color, 0.66))
  g.poly(faces.top).fill(box.color)
}

function at(box: Box, slot: DeskSlot): Box {
  return { ...box, x: box.x + slot.x, y: box.y + slot.y }
}

/** The floor, walls and fixed decoration. Drawn once. */
function drawRoom(g: Graphics): void {
  // Slab edge, so the room has thickness where it meets the void.
  drawBox(g, { x: 0, y: 0, z: -0.3, w: ROOM_WIDTH, d: ROOM_DEPTH, h: 0.3, color: 0x4a382b })

  for (let x = 0; x < ROOM_WIDTH; x++) {
    for (let y = 0; y < ROOM_DEPTH; y++) {
      g.poly(tilePolygon(x, y)).fill((x + y) % 2 === 0 ? FLOOR_A : FLOOR_B)
    }
  }

  // Back walls meeting at the far corner.
  drawBox(g, { x: 0, y: -0.2, z: 0, w: ROOM_WIDTH, d: 0.2, h: WALL_HEIGHT, color: WALL })
  drawBox(g, { x: -0.2, y: 0, z: 0, w: 0.2, d: ROOM_DEPTH, h: WALL_HEIGHT, color: WALL })
  // Skirting boards.
  drawBox(g, { x: 0, y: 0, z: 0, w: ROOM_WIDTH, d: 0.05, h: 0.18, color: 0x8b6f52 })
  drawBox(g, { x: 0, y: 0, z: 0, w: 0.05, d: ROOM_DEPTH, h: 0.18, color: 0x8b6f52 })

  // Windows, laid on the inner wall faces.
  drawBox(g, { x: 1.6, y: -0.01, z: 1.15, w: 2.3, d: 0.01, h: 1.15, color: 0x9ccfe8 })
  drawBox(g, { x: 5.0, y: -0.01, z: 1.15, w: 2.3, d: 0.01, h: 1.15, color: 0x9ccfe8 })
  drawBox(g, { x: -0.01, y: 1.4, z: 1.15, w: 0.01, d: 2.0, h: 1.15, color: 0x9ccfe8 })
  drawBox(g, { x: -0.01, y: 4.3, z: 1.15, w: 0.01, d: 2.0, h: 1.15, color: 0x9ccfe8 })

  // A plant in the far corner.
  drawBox(g, { x: 7.3, y: 0.35, z: 0, w: 0.4, d: 0.4, h: 0.32, color: 0xa4583a })
  drawBox(g, { x: 7.22, y: 0.27, z: 0.32, w: 0.56, d: 0.56, h: 0.3, color: 0x4f8a4a })
  drawBox(g, { x: 7.33, y: 0.38, z: 0.62, w: 0.34, d: 0.34, h: 0.3, color: 0x63a45d })
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
    const key = JSON.stringify([model.label, model.detail, model.tone, model.provenance, dot])
    if (key === this.key) return
    this.key = key
    this.pulse = model.tone === 'wait' || model.tone === 'error'

    this.label.text = model.label
    this.detail.text = model.detail ?? ''
    this.detail.visible = model.detail !== null
    this.tag.text = model.provenance ?? ''
    this.tag.visible = model.provenance !== null

    const padX = 10
    const padY = 7
    const dotSpace = 16
    const row1 = dotSpace + this.label.width + (model.provenance ? 8 + this.tag.width : 0)
    const width = Math.max(row1, model.detail ? this.detail.width : 0) + padX * 2
    const height = padY * 2 + 16 + (model.detail ? 15 : 0)
    const tail = 7
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

  tick(time: number): void {
    const s = this.pulse ? 1 + 0.035 * Math.sin(time * 6) : 1
    this.view.scale.set(s)
  }
}

/** One employee's workstation and the little person at it. */
class Desk {
  readonly container = new Container()
  readonly bubble: Bubble
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

  constructor(
    readonly employee: SceneEmployee,
    readonly slot: DeskSlot,
    resolution: number,
    onSelect: (id: string) => void,
  ) {
    this.shirt = hexToNumber(employee.color)
    this.container.zIndex = slot.x + slot.y
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
    for (const box of deskBoxes()) drawBox(this.front, at(box, slot))

    this.bubble = new Bubble(resolution)
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

  /** Release everything this desk created, including the labels that live in the overlay. */
  dispose(): void {
    this.container.destroy({ children: true })
    this.bubble.view.destroy({ children: true })
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

    this.person.clear()
    for (const box of personBoxes(pose, this.shirt)) drawBox(this.person, at(box, this.slot))

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

    const model = bubbleFor(this.view)
    this.bubble.update(model, LED_COLORS[poseFor(state, 0).led])
    this.bubble.tick(time)
  }

  headScreen(): { x: number; y: number } {
    return project(this.slot.x + HEAD_ANCHOR.x, this.slot.y + HEAD_ANCHOR.y, HEAD_ANCHOR.z)
  }

  nameScreen(): { x: number; y: number } {
    return project(this.slot.x + NAME_ANCHOR.x, this.slot.y + NAME_ANCHOR.y, NAME_ANCHOR.z)
  }
}

/**
 * The isometric voxel office. It draws nothing on its own authority: what each employee is
 * doing comes from their `AgentView`, which comes from real events.
 */
export class OfficeScene {
  private readonly world = new Container()
  private readonly desks = new Container()
  private readonly overlay = new Container()
  private readonly deskViews = new Map<string, Desk>()
  private views: Record<string, AgentView> = {}
  private selected: string | null = null
  private time = 0
  private readonly reducedMotion: boolean
  private readonly resolution: number
  private destroyed = false

  private readonly observer: ResizeObserver

  private constructor(
    private readonly app: Application,
    host: HTMLElement,
    private readonly onSelect: (id: string) => void,
  ) {
    this.resolution = Math.max(2, window.devicePixelRatio || 1)
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const room = new Graphics()
    drawRoom(room)
    this.desks.sortableChildren = true
    this.world.addChild(room, this.desks)
    this.app.stage.addChild(this.world, this.overlay)

    // PixiJS only follows the *window*; the panel also changes size when the roster grows.
    this.observer = new ResizeObserver(() => {
      const width = Math.max(1, host.clientWidth)
      const height = Math.max(1, host.clientHeight)
      if (width !== this.app.screen.width || height !== this.app.screen.height) {
        this.app.renderer.resize(width, height)
      }
    })
    this.observer.observe(host)
    this.app.renderer.on('resize', () => this.layout())
    this.app.ticker.add((ticker) => {
      if (!this.reducedMotion) this.time += ticker.deltaMS / 1000
      for (const desk of this.deskViews.values()) desk.tick(this.time)
      this.placeOverlay()
    })
    this.layout()
  }

  static async create(host: HTMLElement, onSelect: (id: string) => void): Promise<OfficeScene> {
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
    return new OfficeScene(app, host, onSelect)
  }

  setEmployees(employees: readonly SceneEmployee[]): void {
    const { seated } = assignDesks(employees)
    const wanted = new Set(seated.map((s) => s.employee.id))

    for (const [id, desk] of this.deskViews) {
      if (!wanted.has(id)) {
        desk.dispose()
        this.deskViews.delete(id)
      }
    }

    for (const { employee, slot } of seated) {
      const existing = this.deskViews.get(employee.id)
      // A desk is rebuilt when the employee's look changes, or when they move to another desk.
      if (
        existing &&
        existing.slot === slot &&
        existing.employee.color === employee.color &&
        existing.employee.name === employee.name &&
        existing.employee.role === employee.role
      ) {
        continue
      }
      existing?.dispose()
      const desk = new Desk(employee, slot, this.resolution, this.onSelect)
      desk.setView(this.views[employee.id])
      desk.setSelected(this.selected === employee.id)
      this.deskViews.set(employee.id, desk)
      this.desks.addChild(desk.container)
      this.overlay.addChild(desk.nameLabel, desk.roleLabel, desk.bubble.view)
    }
    this.placeOverlay()
  }

  setViews(views: Record<string, AgentView>): void {
    this.views = views
    for (const [id, desk] of this.deskViews) desk.setView(views[id])
  }

  setSelected(id: string | null): void {
    this.selected = id
    for (const [deskId, desk] of this.deskViews) desk.setSelected(deskId === id)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.observer.disconnect()
    this.app.destroy({ removeView: true }, { children: true })
  }

  /** Centre and scale the room to fill the canvas. */
  private layout(): void {
    const { width, height } = this.app.screen
    const fit = fitToViewport(
      roomBounds(ROOM_WIDTH, ROOM_DEPTH, WALL_HEIGHT),
      { width, height },
      28,
    )
    this.world.scale.set(fit.scale)
    this.world.position.set(fit.offsetX, fit.offsetY)
    this.placeOverlay()
  }

  /**
   * Labels live outside the scaled world so their text stays a constant, crisp size however
   * small the room is drawn. This maps each anchor from world to screen.
   */
  private placeOverlay(): void {
    const s = this.world.scale.x
    const { x: ox, y: oy } = this.world.position
    for (const desk of this.deskViews.values()) {
      const head = desk.headScreen()
      desk.bubble.view.position.set(ox + head.x * s, oy + head.y * s)
      const name = desk.nameScreen()
      desk.nameLabel.position.set(ox + name.x * s, oy + name.y * s)
      desk.roleLabel.position.set(ox + name.x * s, oy + name.y * s + 16)
    }
  }
}
