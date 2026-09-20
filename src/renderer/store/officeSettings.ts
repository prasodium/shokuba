import { createOfficeSettingsStore } from './officeSettingsStore'

export const useOfficeSettings = createOfficeSettingsStore({
  get: () => window.shokuba.office.get(),
  save: (settings) => window.shokuba.office.save(settings),
})
