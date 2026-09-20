import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OFFICE_SETTINGS,
  OfficeSettingsSchema,
  ROOM_KINDS,
  type OfficeSettings,
} from '@shared/office'
import { THEMES, applyTheme, hasChanges, savable, themeOf } from './settingsDraft'

const saved = DEFAULT_OFFICE_SETTINGS

describe('THEMES', () => {
  it('each make valid settings, so choosing one can never be refused', () => {
    for (const theme of THEMES) {
      expect(OfficeSettingsSchema.safeParse(applyTheme(saved, theme)).success, theme.id).toBe(true)
    }
  })

  it('have their own id and label, and each looks different from the others', () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length)
    expect(new Set(THEMES.map((t) => t.label)).size).toBe(THEMES.length)
    const looks = THEMES.map((t) => JSON.stringify([t.floors, t.wall]))
    expect(new Set(looks).size).toBe(THEMES.length)
  })

  it('start with the classic one, which is the office as it has always looked', () => {
    expect(THEMES[0]?.id).toBe('classic')
    expect(applyTheme(saved, THEMES[0] as (typeof THEMES)[number])).toEqual(saved)
  })

  it('set a floor for every kind of room', () => {
    for (const theme of THEMES)
      for (const kind of ROOM_KINDS) expect(theme.floors[kind]).toBeDefined()
  })
})

describe('applyTheme', () => {
  const custom: OfficeSettings = {
    ...saved,
    name: 'Acme',
    windows: false,
    plants: false,
    names: { ...saved.names, inbox: 'Desk' },
  }

  it('changes the floors and the wall, and nothing else', () => {
    const ocean = THEMES.find((t) => t.id === 'ocean') as (typeof THEMES)[number]
    const next = applyTheme(custom, ocean)
    expect(next.floors).toEqual(ocean.floors)
    expect(next.wall).toBe(ocean.wall)
    expect({ ...next, floors: custom.floors, wall: custom.wall }).toEqual(custom)
  })

  it('does not share the theme’s floors, so changing one room afterwards never changes the theme', () => {
    const forest = THEMES.find((t) => t.id === 'forest') as (typeof THEMES)[number]
    const next = applyTheme(saved, forest)
    expect(next.floors).not.toBe(forest.floors)
    next.floors.open = 'charcoal'
    expect(forest.floors.open).toBe('oak')
  })
})

describe('themeOf', () => {
  it('finds the theme these floors and wall are exactly', () => {
    for (const theme of THEMES) expect(themeOf(applyTheme(saved, theme))?.id).toBe(theme.id)
  })

  it('is none once any one room or the wall is changed', () => {
    const ocean = THEMES.find((t) => t.id === 'ocean') as (typeof THEMES)[number]
    const base = applyTheme(saved, ocean)
    expect(themeOf({ ...base, floors: { ...base.floors, lab: 'rose' } })).toBeNull()
    expect(themeOf({ ...base, wall: 'white' })).toBeNull()
  })

  it('does not care about the name, the decor or the place names', () => {
    expect(themeOf({ ...saved, name: 'X', windows: false, plants: false })?.id).toBe('classic')
  })
})

describe('savable', () => {
  it('trims the office’s name and every place’s, and changes nothing else', () => {
    const draft: OfficeSettings = {
      ...saved,
      name: '  Acme ',
      names: { ...saved.names, inbox: ' Desk ', tea: '   ' },
    }
    const out = savable(draft)
    expect(out.name).toBe('Acme')
    expect(out.names.inbox).toBe('Desk')
    expect(out.names.tea).toBe('')
    expect({ ...out, name: draft.name, names: draft.names }).toEqual(draft)
  })
})

describe('hasChanges', () => {
  it('is false for the settings just as they are, whatever space is round the names', () => {
    expect(hasChanges(saved, saved)).toBe(false)
    expect(
      hasChanges({ ...saved, name: '   ', names: { ...saved.names, inbox: '  ' } }, saved),
    ).toBe(false)
  })

  it('is true once any one part differs', () => {
    expect(hasChanges({ ...saved, name: 'X' }, saved)).toBe(true)
    expect(hasChanges({ ...saved, floors: { ...saved.floors, open: 'oak' } }, saved)).toBe(true)
    expect(hasChanges({ ...saved, wall: 'sky' }, saved)).toBe(true)
    expect(hasChanges({ ...saved, windows: false }, saved)).toBe(true)
    expect(hasChanges({ ...saved, plants: false }, saved)).toBe(true)
    expect(hasChanges({ ...saved, names: { ...saved.names, board: 'Wall' } }, saved)).toBe(true)
  })
})
