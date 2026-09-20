import {
  DEFAULT_OFFICE_SETTINGS,
  ROOM_KINDS,
  changedParts,
  type OfficeSettings,
} from '@shared/office'

/**
 * Themes are only a quick way to fill in the form: one click sets every room's floor and the walls
 * together. Nothing is stored about a theme, only the floors and wall it set, which can then be
 * changed one by one.
 */
export interface Theme {
  id: string
  label: string
  floors: OfficeSettings['floors']
  wall: OfficeSettings['wall']
}

export const THEMES: readonly Theme[] = [
  {
    id: 'classic',
    label: 'Classic',
    floors: DEFAULT_OFFICE_SETTINGS.floors,
    wall: DEFAULT_OFFICE_SETTINGS.wall,
  },
  {
    id: 'sakura',
    label: 'Sakura',
    floors: {
      open: 'oak',
      pantry: 'cream',
      cabin: 'rose',
      yours: 'plum',
      lab: 'stone',
      meeting: 'rose',
      reading: 'plum',
    },
    wall: 'blush',
  },
  {
    id: 'forest',
    label: 'Forest',
    floors: {
      open: 'oak',
      pantry: 'mint',
      cabin: 'sage',
      yours: 'sage',
      lab: 'stone',
      meeting: 'sage',
      reading: 'slate',
    },
    wall: 'sage',
  },
  {
    id: 'ocean',
    label: 'Ocean',
    floors: {
      open: 'slate',
      pantry: 'cream',
      cabin: 'navy',
      yours: 'slate',
      lab: 'stone',
      meeting: 'navy',
      reading: 'navy',
    },
    wall: 'sky',
  },
  {
    id: 'graphite',
    label: 'Graphite',
    floors: {
      open: 'charcoal',
      pantry: 'stone',
      cabin: 'charcoal',
      yours: 'charcoal',
      lab: 'slate',
      meeting: 'slate',
      reading: 'charcoal',
    },
    wall: 'graphite',
  },
]

/** These settings with a theme's floors and walls, and nothing else changed. */
export function applyTheme(settings: OfficeSettings, theme: Theme): OfficeSettings {
  return { ...settings, floors: { ...theme.floors }, wall: theme.wall }
}

/** The theme these settings are exactly, if any, so the form can show it as chosen. */
export function themeOf(settings: OfficeSettings): Theme | null {
  return (
    THEMES.find(
      (theme) =>
        theme.wall === settings.wall &&
        ROOM_KINDS.every((k) => theme.floors[k] === settings.floors[k]),
    ) ?? null
  )
}

/** The settings as they would be saved: names trimmed, as the main process trims them. */
export function savable(settings: OfficeSettings): OfficeSettings {
  return {
    ...settings,
    name: settings.name.trim(),
    names: Object.fromEntries(
      Object.entries(settings.names).map(([key, value]) => [key, value.trim()]),
    ) as OfficeSettings['names'],
  }
}

/** Whether saving would change anything. Space round a name does not count. */
export function hasChanges(draft: OfficeSettings, saved: OfficeSettings): boolean {
  return changedParts(savable(draft), saved).length > 0
}
