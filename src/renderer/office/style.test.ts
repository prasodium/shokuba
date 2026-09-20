import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NAMES,
  DEFAULT_OFFICE_SETTINGS,
  FLOOR_TONES,
  NAME_KEYS,
  ROOM_KINDS,
  WALL_COLORS,
  floorShades,
  wallColor,
  type OfficeSettings,
} from '@shared/office'
import { buildOffice } from './map'
import { DEFAULT_STYLE, PLACE_NAME_KEY, ROOM_NAME_KEY, styleOf } from './style'

const custom: OfficeSettings = {
  ...DEFAULT_OFFICE_SETTINGS,
  name: 'Acme',
  floors: { ...DEFAULT_OFFICE_SETTINGS.floors, open: 'oak', pantry: 'mint' },
  wall: 'graphite',
  windows: false,
  plants: false,
  names: { ...DEFAULT_OFFICE_SETTINGS.names, inbox: 'Desk', tea: '   ' },
}

describe('styleOf', () => {
  it('turns each room’s floor tone and the wall colour into the numbers the scene paints with', () => {
    const style = styleOf(custom)
    expect(style.floors.open).toEqual(floorShades('oak'))
    expect(style.floors.pantry).toEqual(floorShades('mint'))
    expect(style.floors.lab).toEqual(floorShades(custom.floors.lab))
    expect(style.wall).toBe(wallColor('graphite'))
    for (const kind of ROOM_KINDS) expect(style.floors[kind], kind).toBeDefined()
  })

  it('carries the decor and the office’s name as they are', () => {
    const style = styleOf(custom)
    expect(style.windows).toBe(false)
    expect(style.plants).toBe(false)
    expect(style.title).toBe('Acme')
    expect(styleOf(DEFAULT_OFFICE_SETTINGS)).toMatchObject({
      windows: true,
      plants: true,
      title: '',
    })
  })

  it('names each place as the person did, and as Shokuba does where they did not, never empty', () => {
    const style = styleOf(custom)
    expect(style.names.inbox).toBe('Desk')
    expect(style.names.tea).toBe(DEFAULT_NAMES.tea)
    for (const key of NAME_KEYS) expect(style.names[key].length, key).toBeGreaterThan(0)
  })

  it('is, for the default settings, the office as it was drawn before it could be changed', () => {
    expect(DEFAULT_STYLE).toEqual(styleOf(DEFAULT_OFFICE_SETTINGS))
    expect(DEFAULT_STYLE.floors.open).toEqual([0x7a5c44, 0x86664c])
    expect(DEFAULT_STYLE.floors.meeting).toEqual([0x55627a, 0x5f6d86])
    expect(DEFAULT_STYLE.wall).toBe(0xeadcbf)
    expect(DEFAULT_STYLE.names).toEqual(DEFAULT_NAMES)
  })

  it('gives every floor tone and every wall colour a distinct look', () => {
    const floors = FLOOR_TONES.map((tone) => {
      const settings = {
        ...DEFAULT_OFFICE_SETTINGS,
        floors: Object.fromEntries(ROOM_KINDS.map((k) => [k, tone.id])) as OfficeSettings['floors'],
      }
      return styleOf(settings).floors.open.join()
    })
    expect(new Set(floors).size).toBe(FLOOR_TONES.length)
    const walls = WALL_COLORS.map(
      (color) => styleOf({ ...DEFAULT_OFFICE_SETTINGS, wall: color.id }).wall,
    )
    expect(new Set(walls).size).toBe(WALL_COLORS.length)
  })
})

describe('which name goes on which place', () => {
  const map = buildOffice()

  it('names every kind of place that shows a name on the floor, and every named room', () => {
    // The places the scene puts a tag on, and the rooms with a label.
    const tagged = ['board', 'qa', 'inbox', 'reading', 'tea', 'snacks'] as const
    for (const kind of tagged) expect(PLACE_NAME_KEY[kind], kind).toBeDefined()
    for (const room of map.rooms.filter((r) => r.label)) {
      expect(ROOM_NAME_KEY[room.id], room.id).toBeDefined()
    }
  })

  it('gives each name to exactly one kind of place or room, so renaming one never renames another', () => {
    const keys = [...Object.values(PLACE_NAME_KEY), ...Object.values(ROOM_NAME_KEY)]
    expect(new Set(keys).size).toBe(keys.length)
    expect([...keys].sort()).toEqual([...NAME_KEYS].sort())
  })

  it('starts each place with the name Shokuba has always given it', () => {
    for (const place of map.places) {
      const key = PLACE_NAME_KEY[place.kind]
      if (key) expect(DEFAULT_STYLE.names[key], place.id).toBe(place.label)
    }
    for (const room of map.rooms.filter((r) => r.label)) {
      const key = ROOM_NAME_KEY[room.id] as keyof typeof DEFAULT_NAMES
      expect(DEFAULT_STYLE.names[key], room.id).toBe(room.label)
    }
  })
})
