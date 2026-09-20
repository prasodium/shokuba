import { describe, expect, it } from 'vitest'
import { DEFAULT_OFFICE_SETTINGS, type OfficeSettings } from '@shared/office'
import { createOfficeSettingsStore, type OfficeSettingsApi } from './officeSettingsStore'

const dressed: OfficeSettings = { ...DEFAULT_OFFICE_SETTINGS, name: 'Acme', wall: 'sky' }

describe('the office settings store', () => {
  it('starts as the office has always looked, and reads how it is dressed', async () => {
    const api: OfficeSettingsApi = { get: async () => dressed, save: async (s) => s }
    const store = createOfficeSettingsStore(api)
    expect(store.getState().settings).toEqual(DEFAULT_OFFICE_SETTINGS)
    await store.getState().refresh()
    expect(store.getState().settings).toEqual(dressed)
  })

  it('keeps the look it has when a read fails', async () => {
    const api: OfficeSettingsApi = {
      get: async () => {
        throw new Error('gone')
      },
      save: async (s) => s,
    }
    const store = createOfficeSettingsStore(api)
    store.setState({ settings: dressed })
    await store.getState().refresh()
    expect(store.getState().settings).toEqual(dressed)
  })

  it('keeps what was saved, as the main process settled it', async () => {
    const api: OfficeSettingsApi = {
      get: async () => DEFAULT_OFFICE_SETTINGS,
      save: async (s) => ({ ...s, name: s.name.trim() }),
    }
    const store = createOfficeSettingsStore(api)
    const result = await store.getState().save({ ...dressed, name: '  Acme  ' })
    expect(result).toEqual({ ok: true, value: dressed })
    expect(store.getState().settings).toEqual(dressed)
  })

  it('gives back a refusal as plain words, and keeps the look it has', async () => {
    const api: OfficeSettingsApi = {
      get: async () => DEFAULT_OFFICE_SETTINGS,
      save: async () => {
        throw new Error("Error invoking remote method 'x': OfficeError: wall: Invalid option")
      },
    }
    const store = createOfficeSettingsStore(api)
    store.setState({ settings: dressed })
    const result = await store.getState().save(DEFAULT_OFFICE_SETTINGS)
    expect(result).toEqual({ ok: false, error: 'wall: Invalid option' })
    expect(store.getState().settings).toEqual(dressed)
  })
})
