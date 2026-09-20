import { z } from 'zod'

/**
 * How the person has dressed their office: the office's name, the tone of each kind of room's
 * floor, the colour of the walls, whether there are windows and plants, and what the shared places
 * are called. Everything is a choice from a fixed set or a short name, so what is saved can always
 * be drawn. The floor plan itself (where rooms, walls and desks are) is not customised here: the
 * tests that prove the office is walkable stay true for every choice. The defaults are the office
 * as it has always looked.
 */

export const ROOM_KINDS = ['open', 'pantry', 'cabin', 'yours', 'lab', 'meeting', 'reading'] as const
export type RoomKindId = (typeof ROOM_KINDS)[number]

/** How each kind of room is described to a person choosing its floor. */
export const ROOM_KIND_LABELS: Record<RoomKindId, string> = {
  open: 'Open desk area',
  pantry: 'Pantry',
  cabin: 'Manager cabin',
  yours: 'Your cabin',
  lab: 'Lab',
  meeting: 'Meeting room',
  reading: 'Reading room',
}

/** Floor tones. Each is drawn as a chequer of two shades. */
export const FLOOR_TONES = [
  { id: 'walnut', label: 'Walnut', a: '#7a5c44', b: '#86664c' },
  { id: 'oak', label: 'Oak', a: '#a07a52', b: '#ab8659' },
  { id: 'cherry', label: 'Cherry', a: '#8a4a3c', b: '#955447' },
  { id: 'cream', label: 'Cream', a: '#cfc6b0', b: '#dbd2bc' },
  { id: 'sage', label: 'Sage', a: '#5f6d64', b: '#69776e' },
  { id: 'plum', label: 'Plum', a: '#6b5f72', b: '#756a7c' },
  { id: 'stone', label: 'Stone', a: '#6f6a5c', b: '#7b7566' },
  { id: 'navy', label: 'Navy', a: '#55627a', b: '#5f6d86' },
  { id: 'slate', label: 'Slate', a: '#4f5a6e', b: '#596479' },
  { id: 'mint', label: 'Mint', a: '#8db8a4', b: '#99c4b0' },
  { id: 'rose', label: 'Rose', a: '#b98a92', b: '#c4959d' },
  { id: 'charcoal', label: 'Charcoal', a: '#3c3c44', b: '#46464e' },
] as const

export const WALL_COLORS = [
  { id: 'cream', label: 'Cream', hex: '#eadcbf' },
  { id: 'white', label: 'White', hex: '#f2efe6' },
  { id: 'sky', label: 'Sky', hex: '#c9d9e6' },
  { id: 'sage', label: 'Sage', hex: '#cfdcc4' },
  { id: 'blush', label: 'Blush', hex: '#ecd3d0' },
  { id: 'stone', label: 'Stone', hex: '#d0c7b6' },
  { id: 'graphite', label: 'Graphite', hex: '#8b8f99' },
] as const

export type FloorToneId = (typeof FLOOR_TONES)[number]['id']
export type WallColorId = (typeof WALL_COLORS)[number]['id']

/** The shared places and rooms that have a name of their own on the floor. */
export const NAME_KEYS = [
  'managerCabin',
  'meetingRoom',
  'readingRoom',
  'inbox',
  'bench',
  'board',
  'tea',
  'snacks',
] as const
export type NameKey = (typeof NAME_KEYS)[number]

export const DEFAULT_NAMES: Record<NameKey, string> = {
  managerCabin: 'Manager cabin',
  meetingRoom: 'Meeting room',
  readingRoom: 'Reading room',
  inbox: 'Your inbox',
  bench: 'QA bench',
  board: 'Mission board',
  tea: 'Tea & coffee',
  snacks: 'Snacks',
}

/** The longest a name on the floor can be: it has to fit in a small tag. */
export const MAX_NAME = 30
export const MAX_OFFICE_NAME = 40

const printable = (value: string): boolean => !/[\p{Cc}\p{Cf}]/u.test(value)

const tag = z.string().trim().max(MAX_NAME).refine(printable, 'must not contain control characters')

const ids = <T extends readonly { id: string }[]>(list: T) =>
  list.map((entry) => entry.id) as [T[number]['id'], ...T[number]['id'][]]

const toneId = z.enum(ids(FLOOR_TONES))

export const OfficeSettingsSchema = z.strictObject({
  /** What the office is called, shown over it. Empty for no name. */
  name: z
    .string()
    .trim()
    .max(MAX_OFFICE_NAME)
    .refine(printable, 'must not contain control characters'),
  floors: z.strictObject({
    open: toneId,
    pantry: toneId,
    cabin: toneId,
    yours: toneId,
    lab: toneId,
    meeting: toneId,
    reading: toneId,
  }),
  wall: z.enum(ids(WALL_COLORS)),
  windows: z.boolean(),
  plants: z.boolean(),
  /** What each shared place is called. Empty means what Shokuba calls it. */
  names: z.strictObject({
    managerCabin: tag,
    meetingRoom: tag,
    readingRoom: tag,
    inbox: tag,
    bench: tag,
    board: tag,
    tea: tag,
    snacks: tag,
  }),
})
export type OfficeSettings = z.infer<typeof OfficeSettingsSchema>

/** The office as it has always looked. */
export const DEFAULT_OFFICE_SETTINGS: OfficeSettings = {
  name: '',
  floors: {
    open: 'walnut',
    pantry: 'cream',
    cabin: 'sage',
    yours: 'plum',
    lab: 'stone',
    meeting: 'navy',
    reading: 'slate',
  },
  wall: 'cream',
  windows: true,
  plants: true,
  names: {
    managerCabin: '',
    meetingRoom: '',
    readingRoom: '',
    inbox: '',
    bench: '',
    board: '',
    tea: '',
    snacks: '',
  },
}

/** What a shared place is called: the person's name for it, or Shokuba's. */
export function nameOf(settings: OfficeSettings, key: NameKey): string {
  return settings.names[key].trim() || DEFAULT_NAMES[key]
}

/** Saved settings, or the defaults if there are none or they cannot be read. It never throws. */
export function parseOfficeSettings(stored: string | null | undefined): OfficeSettings {
  if (!stored) return DEFAULT_OFFICE_SETTINGS
  try {
    const parsed = OfficeSettingsSchema.safeParse(JSON.parse(stored))
    return parsed.success ? parsed.data : DEFAULT_OFFICE_SETTINGS
  } catch {
    return DEFAULT_OFFICE_SETTINGS
  }
}

/** The names of the parts of the settings that differ between two, for recording a change. */
export function changedParts(a: OfficeSettings, b: OfficeSettings): string[] {
  const parts: string[] = []
  if (a.name !== b.name) parts.push('name')
  if (ROOM_KINDS.some((kind) => a.floors[kind] !== b.floors[kind])) parts.push('floors')
  if (a.wall !== b.wall) parts.push('wall')
  if (a.windows !== b.windows) parts.push('windows')
  if (a.plants !== b.plants) parts.push('plants')
  if (NAME_KEYS.some((key) => a.names[key] !== b.names[key])) parts.push('names')
  return parts
}

/** The hex of a floor tone's two shades, as numbers 0xrrggbb. */
export function floorShades(id: FloorToneId): readonly [number, number] {
  const tone = FLOOR_TONES.find((t) => t.id === id) ?? FLOOR_TONES[0]
  return [Number.parseInt(tone.a.slice(1), 16), Number.parseInt(tone.b.slice(1), 16)]
}

/** The colour of a wall colour, as 0xrrggbb. */
export function wallColor(id: WallColorId): number {
  const color = WALL_COLORS.find((c) => c.id === id) ?? WALL_COLORS[0]
  return Number.parseInt(color.hex.slice(1), 16)
}
