import {
  DEFAULT_OFFICE_SETTINGS,
  NAME_KEYS,
  ROOM_KINDS,
  floorShades,
  nameOf,
  wallColor,
  type NameKey,
  type OfficeSettings,
  type RoomKindId,
} from '@shared/office'
import type { PlaceKind } from './map'

/**
 * How the office is dressed, as the scene draws it: colours as numbers, and the name every shared
 * place goes by. Pure: the person's settings go in, and what to paint comes out.
 */
export interface OfficeStyle {
  /** Each kind of room's floor, as its two chequer shades. */
  floors: Record<RoomKindId, readonly [number, number]>
  wall: number
  windows: boolean
  plants: boolean
  /** What each shared place is called (the person's name for it, or Shokuba's, never empty). */
  names: Record<NameKey, string>
  /** What the office is called, or empty for no name. */
  title: string
}

export function styleOf(settings: OfficeSettings): OfficeStyle {
  return {
    floors: Object.fromEntries(
      ROOM_KINDS.map((kind) => [kind, floorShades(settings.floors[kind])]),
    ) as OfficeStyle['floors'],
    wall: wallColor(settings.wall),
    windows: settings.windows,
    plants: settings.plants,
    names: Object.fromEntries(NAME_KEYS.map((key) => [key, nameOf(settings, key)])) as Record<
      NameKey,
      string
    >,
    title: settings.name,
  }
}

/** The office as it has always looked. */
export const DEFAULT_STYLE: OfficeStyle = styleOf(DEFAULT_OFFICE_SETTINGS)

/** Which name a shared place goes by. Places with no name of their own (a table) have none. */
export const PLACE_NAME_KEY: Partial<Record<PlaceKind, NameKey>> = {
  board: 'board',
  qa: 'bench',
  inbox: 'inbox',
  reading: 'readingRoom',
  tea: 'tea',
  snacks: 'snacks',
}

/** Which name a named room goes by, by the room's id. */
export const ROOM_NAME_KEY: Readonly<Record<string, NameKey>> = {
  manager: 'managerCabin',
  meeting: 'meetingRoom',
}
