import { createOfficeSettingsStore } from './officeSettingsStore'
import { shokuba } from '../api'

export const useOfficeSettings = createOfficeSettingsStore({
  get: () => shokuba.office.get(),
  save: (settings) => shokuba.office.save(settings),
})
