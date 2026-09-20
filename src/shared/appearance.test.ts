import { describe, expect, it } from 'vitest'
import {
  ACCESSORIES,
  AppearanceSchema,
  DEFAULT_APPEARANCE,
  HAIR_COLORS,
  HAIR_STYLES,
  SKIN_TONES,
  hairColor,
  parseAppearance,
  sameAppearance,
  skinColor,
} from './appearance'

describe('the choices', () => {
  it('each have their own id, so a choice is never ambiguous', () => {
    for (const list of [SKIN_TONES, HAIR_COLORS, HAIR_STYLES, ACCESSORIES]) {
      const ids = list.map((entry) => entry.id)
      expect(new Set(ids).size).toBe(ids.length)
      for (const entry of list) expect(entry.label.length).toBeGreaterThan(0)
    }
  })

  it('have real colours, each different from the others', () => {
    for (const list of [SKIN_TONES, HAIR_COLORS]) {
      const hexes = list.map((entry) => entry.hex)
      for (const hex of hexes) expect(hex).toMatch(/^#[0-9a-f]{6}$/)
      expect(new Set(hexes).size).toBe(hexes.length)
    }
  })

  it('include the ones everyone had before this could be changed', () => {
    expect(skinColor('sand')).toBe(0xe7b48c)
    expect(hairColor('black')).toBe(0x2b2118)
  })
})

describe('the default look', () => {
  it('is that old look, with nothing worn', () => {
    expect(DEFAULT_APPEARANCE).toEqual({
      skin: 'sand',
      hair: 'black',
      style: 'short',
      accessory: 'none',
    })
  })

  it('is a valid appearance', () => {
    expect(AppearanceSchema.safeParse(DEFAULT_APPEARANCE).success).toBe(true)
  })
})

describe('AppearanceSchema', () => {
  it('accepts every combination of the choices', () => {
    for (const skin of SKIN_TONES) {
      for (const hair of HAIR_COLORS) {
        for (const style of HAIR_STYLES) {
          for (const accessory of ACCESSORIES) {
            const look = { skin: skin.id, hair: hair.id, style: style.id, accessory: accessory.id }
            expect(AppearanceSchema.safeParse(look).success).toBe(true)
          }
        }
      }
    }
  })

  it('refuses anything that is not one of the choices, including a free colour', () => {
    const bad = [
      { ...DEFAULT_APPEARANCE, skin: '#ff0000' },
      { ...DEFAULT_APPEARANCE, hair: 'purple' },
      { ...DEFAULT_APPEARANCE, style: 'mohawk' },
      { ...DEFAULT_APPEARANCE, accessory: 'monocle' },
      { ...DEFAULT_APPEARANCE, skin: '' },
      { ...DEFAULT_APPEARANCE, skin: 3 },
    ]
    for (const look of bad)
      expect(AppearanceSchema.safeParse(look).success, JSON.stringify(look)).toBe(false)
  })

  it('refuses a missing part or an extra one', () => {
    expect(
      AppearanceSchema.safeParse({ skin: 'sand', hair: 'black', style: 'short' }).success,
    ).toBe(false)
    expect(AppearanceSchema.safeParse({ ...DEFAULT_APPEARANCE, extra: 'x' }).success).toBe(false)
    expect(AppearanceSchema.safeParse(null).success).toBe(false)
    expect(AppearanceSchema.safeParse('sand').success).toBe(false)
  })
})

describe('parseAppearance', () => {
  it('reads what was stored', () => {
    const look = { skin: 'umber', hair: 'blue', style: 'bun', accessory: 'cap' }
    expect(parseAppearance(JSON.stringify(look))).toEqual(look)
  })

  it('gives the default for nothing, or for anything that cannot be read, and never throws', () => {
    for (const stored of [
      null,
      undefined,
      '',
      '{}',
      'not json',
      '[]',
      'null',
      '{"skin":"sand"}',
      JSON.stringify({ ...DEFAULT_APPEARANCE, hair: 'purple' }),
    ]) {
      expect(parseAppearance(stored), String(stored)).toEqual(DEFAULT_APPEARANCE)
    }
  })
})

describe('the colours', () => {
  it('turn each choice into its own colour', () => {
    const skins = SKIN_TONES.map((tone) => skinColor(tone.id))
    expect(new Set(skins).size).toBe(SKIN_TONES.length)
    const hairs = HAIR_COLORS.map((color) => hairColor(color.id))
    expect(new Set(hairs).size).toBe(HAIR_COLORS.length)
    expect(skinColor('ebony')).toBe(0x5a3721)
    expect(hairColor('blue')).toBe(0x3f6fb5)
  })
})

describe('a colour for an id that is not there', () => {
  it('is the default look’s, so something is always drawn', () => {
    expect(skinColor('nobody' as never)).toBe(skinColor('sand'))
    expect(hairColor('nobody' as never)).toBe(hairColor('black'))
  })
})

describe('sameAppearance', () => {
  it('is true for the same look, however it was made', () => {
    expect(sameAppearance(DEFAULT_APPEARANCE, { ...DEFAULT_APPEARANCE })).toBe(true)
  })

  it('is false when any one part differs', () => {
    expect(sameAppearance(DEFAULT_APPEARANCE, { ...DEFAULT_APPEARANCE, skin: 'ebony' })).toBe(false)
    expect(sameAppearance(DEFAULT_APPEARANCE, { ...DEFAULT_APPEARANCE, hair: 'blue' })).toBe(false)
    expect(sameAppearance(DEFAULT_APPEARANCE, { ...DEFAULT_APPEARANCE, style: 'bun' })).toBe(false)
    expect(sameAppearance(DEFAULT_APPEARANCE, { ...DEFAULT_APPEARANCE, accessory: 'cap' })).toBe(
      false,
    )
  })
})
