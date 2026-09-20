import { create } from 'zustand'
import { DEFAULT_OFFICE_SETTINGS, type OfficeSettings } from '@shared/office'
import { errorMessage } from '../lib/errors'
import type { Outcome } from '../lib/outcome'

/** What the store needs from the main process. */
export interface OfficeSettingsApi {
  get(): Promise<OfficeSettings>
  save(settings: OfficeSettings): Promise<OfficeSettings>
}

export interface OfficeSettingsState {
  /** How the office is dressed. It is the office as it has always looked until it is read. */
  settings: OfficeSettings
  refresh(): Promise<void>
  save(settings: OfficeSettings): Promise<Outcome<OfficeSettings>>
}

/** Made from an `api` so it can be tested without a window; the app's own is in `officeSettings.ts`. */
export function createOfficeSettingsStore(api: OfficeSettingsApi) {
  return create<OfficeSettingsState>((set) => ({
    settings: DEFAULT_OFFICE_SETTINGS,

    async refresh() {
      try {
        set({ settings: await api.get() })
      } catch {
        // The next event will trigger another attempt; until then the office keeps its look.
      }
    },

    async save(settings) {
      try {
        const saved = await api.save(settings)
        set({ settings: saved })
        return { ok: true, value: saved }
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      }
    },
  }))
}
