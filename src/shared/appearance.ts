import { z } from 'zod'

/**
 * How an employee's little person looks, apart from their shirt (which is their `color`). Every
 * part is one of a fixed set of choices, named by an id and never a free colour or text, so what is
 * stored can always be drawn and can never be anything else. The default is the look every employee
 * had before this could be changed, so nobody looks different until they are edited.
 */

export const SKIN_TONES = [
  { id: 'porcelain', label: 'Porcelain', hex: '#f3d3b7' },
  { id: 'sand', label: 'Sand', hex: '#e7b48c' },
  { id: 'honey', label: 'Honey', hex: '#c98f5f' },
  { id: 'bronze', label: 'Bronze', hex: '#a06a42' },
  { id: 'umber', label: 'Umber', hex: '#7a4c2f' },
  { id: 'ebony', label: 'Ebony', hex: '#5a3721' },
] as const

export const HAIR_COLORS = [
  { id: 'black', label: 'Black', hex: '#2b2118' },
  { id: 'brown', label: 'Brown', hex: '#5a3a22' },
  { id: 'chestnut', label: 'Chestnut', hex: '#8a4b2a' },
  { id: 'blonde', label: 'Blonde', hex: '#d9b25f' },
  { id: 'ginger', label: 'Ginger', hex: '#b5502c' },
  { id: 'grey', label: 'Grey', hex: '#a8a8a8' },
  { id: 'white', label: 'White', hex: '#e8e4dc' },
  { id: 'blue', label: 'Blue', hex: '#3f6fb5' },
] as const

export const HAIR_STYLES = [
  { id: 'short', label: 'Short' },
  { id: 'long', label: 'Long' },
  { id: 'bun', label: 'Bun' },
  { id: 'bald', label: 'Bald' },
] as const

export const ACCESSORIES = [
  { id: 'none', label: 'None' },
  { id: 'glasses', label: 'Glasses' },
  { id: 'headphones', label: 'Headphones' },
  { id: 'cap', label: 'Cap' },
] as const

type Ids<T extends readonly { id: string }[]> = T[number]['id']
export type SkinId = Ids<typeof SKIN_TONES>
export type HairColorId = Ids<typeof HAIR_COLORS>
export type HairStyleId = Ids<typeof HAIR_STYLES>
export type AccessoryId = Ids<typeof ACCESSORIES>

const ids = <T extends readonly { id: string }[]>(list: T) =>
  list.map((entry) => entry.id) as [Ids<T>, ...Ids<T>[]]

export const AppearanceSchema = z.strictObject({
  skin: z.enum(ids(SKIN_TONES)),
  hair: z.enum(ids(HAIR_COLORS)),
  style: z.enum(ids(HAIR_STYLES)),
  accessory: z.enum(ids(ACCESSORIES)),
})
export type Appearance = z.infer<typeof AppearanceSchema>

/** The look everyone had before it could be changed: sand skin, short black hair, nothing worn. */
export const DEFAULT_APPEARANCE: Appearance = {
  skin: 'sand',
  hair: 'black',
  style: 'short',
  accessory: 'none',
}

/** Whether two looks are the same in every part. */
export function sameAppearance(a: Appearance, b: Appearance): boolean {
  return (
    a.skin === b.skin && a.hair === b.hair && a.style === b.style && a.accessory === b.accessory
  )
}

/** A stored appearance, or the default if there is none or it cannot be read. It never throws. */
export function parseAppearance(stored: string | null | undefined): Appearance {
  if (!stored) return DEFAULT_APPEARANCE
  try {
    const parsed = AppearanceSchema.safeParse(JSON.parse(stored))
    return parsed.success ? parsed.data : DEFAULT_APPEARANCE
  } catch {
    return DEFAULT_APPEARANCE
  }
}

const toNumber = (hex: string): number => Number.parseInt(hex.slice(1), 16)

/** The colour to draw a skin tone in, as 0xrrggbb. */
export function skinColor(id: SkinId): number {
  return toNumber((SKIN_TONES.find((tone) => tone.id === id) ?? SKIN_TONES[1]).hex)
}

/** The colour to draw a hair colour in, as 0xrrggbb. */
export function hairColor(id: HairColorId): number {
  return toNumber((HAIR_COLORS.find((color) => color.id === id) ?? HAIR_COLORS[0]).hex)
}
