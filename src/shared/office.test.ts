import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NAMES,
  DEFAULT_OFFICE_SETTINGS,
  FLOOR_TONES,
  MAX_NAME,
  MAX_OFFICE_NAME,
  NAME_KEYS,
  OfficeSettingsSchema,
  ROOM_KINDS,
  ROOM_KIND_LABELS,
  WALL_COLORS,
  changedParts,
  floorShades,
  nameOf,
  parseOfficeSettings,
  wallColor,
  type OfficeSettings,
} from './office'

const custom: OfficeSettings = {
  name: 'Acme Studio',
  floors: {
    open: 'oak',
    pantry: 'mint',
    cabin: 'rose',
    yours: 'charcoal',
    lab: 'slate',
    meeting: 'cherry',
    reading: 'navy',
  },
  wall: 'sky',
  windows: false,
  plants: false,
  names: { ...DEFAULT_OFFICE_SETTINGS.names, inbox: 'Desk', board: 'Wall of tasks' },
}

describe('the choices', () => {
  it('each have their own id and a label', () => {
    for (const list of [FLOOR_TONES, WALL_COLORS]) {
      const listIds = list.map((entry) => entry.id)
      expect(new Set(listIds).size).toBe(listIds.length)
      for (const entry of list) expect(entry.label.length).toBeGreaterThan(0)
    }
  })

  it('are real colours, different from each other, and a floor tone’s two shades differ', () => {
    for (const tone of FLOOR_TONES) {
      expect(tone.a).toMatch(/^#[0-9a-f]{6}$/)
      expect(tone.b).toMatch(/^#[0-9a-f]{6}$/)
      expect(tone.a).not.toBe(tone.b)
    }
    expect(new Set(FLOOR_TONES.map((t) => t.a)).size).toBe(FLOOR_TONES.length)
    expect(new Set(WALL_COLORS.map((c) => c.hex)).size).toBe(WALL_COLORS.length)
  })

  it('describe every kind of room and every shared place', () => {
    for (const kind of ROOM_KINDS) expect(ROOM_KIND_LABELS[kind].length).toBeGreaterThan(0)
    for (const key of NAME_KEYS) expect(DEFAULT_NAMES[key].length).toBeGreaterThan(0)
    for (const name of Object.values(DEFAULT_NAMES))
      expect(name.length).toBeLessThanOrEqual(MAX_NAME)
  })
})

describe('the default office', () => {
  it('is valid, and is the office as it has always looked', () => {
    expect(OfficeSettingsSchema.safeParse(DEFAULT_OFFICE_SETTINGS).success).toBe(true)
    // The floors and the walls the office was drawn with before it could be changed.
    const old = {
      open: [0x7a5c44, 0x86664c],
      pantry: [0xcfc6b0, 0xdbd2bc],
      cabin: [0x5f6d64, 0x69776e],
      yours: [0x6b5f72, 0x756a7c],
      lab: [0x6f6a5c, 0x7b7566],
      meeting: [0x55627a, 0x5f6d86],
      reading: [0x4f5a6e, 0x596479],
    }
    for (const kind of ROOM_KINDS) {
      expect(floorShades(DEFAULT_OFFICE_SETTINGS.floors[kind]), kind).toEqual(old[kind])
    }
    expect(wallColor(DEFAULT_OFFICE_SETTINGS.wall)).toBe(0xeadcbf)
  })

  it('has windows and plants, no name, and Shokuba’s own names for everything', () => {
    expect(DEFAULT_OFFICE_SETTINGS.windows).toBe(true)
    expect(DEFAULT_OFFICE_SETTINGS.plants).toBe(true)
    expect(DEFAULT_OFFICE_SETTINGS.name).toBe('')
    for (const key of NAME_KEYS)
      expect(nameOf(DEFAULT_OFFICE_SETTINGS, key)).toBe(DEFAULT_NAMES[key])
  })
})

describe('OfficeSettingsSchema', () => {
  it('accepts a full set of settings, and trims the names', () => {
    expect(OfficeSettingsSchema.parse(custom)).toEqual(custom)
    const padded = OfficeSettingsSchema.parse({ ...custom, name: '  Acme  ' })
    expect(padded.name).toBe('Acme')
  })

  it('accepts every floor tone in every room and every wall colour', () => {
    for (const tone of FLOOR_TONES) {
      const floors = Object.fromEntries(ROOM_KINDS.map((k) => [k, tone.id]))
      expect(OfficeSettingsSchema.safeParse({ ...custom, floors }).success, tone.id).toBe(true)
    }
    for (const color of WALL_COLORS) {
      expect(OfficeSettingsSchema.safeParse({ ...custom, wall: color.id }).success, color.id).toBe(
        true,
      )
    }
  })

  it('refuses a floor, a wall or a name that is not one of the choices, including a free colour', () => {
    const bad: unknown[] = [
      { ...custom, wall: '#ffffff' },
      { ...custom, wall: 'purple' },
      { ...custom, floors: { ...custom.floors, open: '#123456' } },
      { ...custom, floors: { ...custom.floors, open: 'lava' } },
      { ...custom, floors: { ...custom.floors, extra: 'oak' } },
      { ...custom, windows: 'yes' },
      { ...custom, plants: 1 },
      { ...custom, extra: true },
    ]
    for (const settings of bad) {
      expect(OfficeSettingsSchema.safeParse(settings).success, JSON.stringify(settings)).toBe(false)
    }
  })

  it('refuses a part that is missing', () => {
    const without = (key: string) =>
      Object.fromEntries(Object.entries(custom).filter(([k]) => k !== key))
    for (const key of Object.keys(custom)) {
      expect(OfficeSettingsSchema.safeParse(without(key)).success, key).toBe(false)
    }
    const floors = Object.fromEntries(Object.entries(custom.floors).filter(([k]) => k !== 'open'))
    expect(OfficeSettingsSchema.safeParse({ ...custom, floors }).success).toBe(false)
  })

  it('refuses an over-long name, or one with control characters', () => {
    expect(
      OfficeSettingsSchema.safeParse({ ...custom, name: 'x'.repeat(MAX_OFFICE_NAME + 1) }).success,
    ).toBe(false)
    expect(
      OfficeSettingsSchema.safeParse({ ...custom, name: 'x'.repeat(MAX_OFFICE_NAME) }).success,
    ).toBe(true)
    expect(
      OfficeSettingsSchema.safeParse({ ...custom, name: `a${String.fromCharCode(0)}` }).success,
    ).toBe(false)
    for (const key of NAME_KEYS) {
      const names = { ...custom.names, [key]: 'x'.repeat(MAX_NAME + 1) }
      expect(OfficeSettingsSchema.safeParse({ ...custom, names }).success, key).toBe(false)
      const ctl = { ...custom.names, [key]: `a${String.fromCharCode(7)}b` }
      expect(OfficeSettingsSchema.safeParse({ ...custom, names: ctl }).success, key).toBe(false)
    }
  })
})

describe('nameOf', () => {
  it('is the person’s name for a place, or Shokuba’s when there is none or it is only space', () => {
    expect(nameOf(custom, 'inbox')).toBe('Desk')
    expect(nameOf(custom, 'tea')).toBe('Tea & coffee')
    expect(nameOf({ ...custom, names: { ...custom.names, inbox: '   ' } }, 'inbox')).toBe(
      'Your inbox',
    )
  })
})

describe('parseOfficeSettings', () => {
  it('reads what was stored', () => {
    expect(parseOfficeSettings(JSON.stringify(custom))).toEqual(custom)
  })

  it('gives the defaults for nothing, or anything that cannot be read, and never throws', () => {
    for (const stored of [
      null,
      undefined,
      '',
      '{}',
      'not json',
      '[]',
      'null',
      JSON.stringify({ ...custom, wall: 'nope' }),
      JSON.stringify({ ...custom, floors: {} }),
    ]) {
      expect(parseOfficeSettings(stored), String(stored)).toEqual(DEFAULT_OFFICE_SETTINGS)
    }
  })
})

describe('changedParts', () => {
  it('is nothing for the same settings', () => {
    expect(changedParts(custom, { ...custom })).toEqual([])
  })

  it('names each part that differs, and only those', () => {
    const d = DEFAULT_OFFICE_SETTINGS
    expect(changedParts(d, { ...d, name: 'X' })).toEqual(['name'])
    expect(changedParts(d, { ...d, floors: { ...d.floors, lab: 'oak' } })).toEqual(['floors'])
    expect(changedParts(d, { ...d, wall: 'sky' })).toEqual(['wall'])
    expect(changedParts(d, { ...d, windows: false })).toEqual(['windows'])
    expect(changedParts(d, { ...d, plants: false })).toEqual(['plants'])
    expect(changedParts(d, { ...d, names: { ...d.names, snacks: 'Bites' } })).toEqual(['names'])
    expect(changedParts(d, custom)).toEqual([
      'name',
      'floors',
      'wall',
      'windows',
      'plants',
      'names',
    ])
  })
})

describe('the colours', () => {
  it('turn each choice into its own numbers', () => {
    const shades = FLOOR_TONES.map((t) => floorShades(t.id).join())
    expect(new Set(shades).size).toBe(FLOOR_TONES.length)
    expect(floorShades('oak')).toEqual([0xa07a52, 0xab8659])
    expect(wallColor('graphite')).toBe(0x8b8f99)
    expect(new Set(WALL_COLORS.map((c) => wallColor(c.id))).size).toBe(WALL_COLORS.length)
  })

  it('fall back to the first choice for an id that is not there, so something is always drawn', () => {
    expect(floorShades('nope' as never)).toEqual(floorShades('walnut'))
    expect(wallColor('nope' as never)).toBe(wallColor('cream'))
  })
})
