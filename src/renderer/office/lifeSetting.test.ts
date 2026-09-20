import { describe, expect, it } from 'vitest'
import { readLifeSetting, writeLifeSetting } from './lifeSetting'

/** A store that keeps what it is given, like the browser's. */
function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  }
}

const broken = {
  getItem: (): string | null => {
    throw new Error('blocked')
  },
  setItem: (): void => {
    throw new Error('blocked')
  },
}

describe('the office life setting', () => {
  it('is on until it is turned off', () => {
    expect(readLifeSetting(memory())).toBe(true)
    expect(readLifeSetting(undefined)).toBe(true)
  })

  it('remembers being turned off, and on again', () => {
    const store = memory()
    writeLifeSetting(store, false)
    expect(readLifeSetting(store)).toBe(false)
    writeLifeSetting(store, true)
    expect(readLifeSetting(store)).toBe(true)
  })

  it('keeps it under one name of its own', () => {
    const store = memory()
    writeLifeSetting(store, false)
    expect([...store.data.keys()]).toEqual(['shokuba.officeLife'])
  })

  it('reads anything that is not a clear "off" as on, so a damaged value never hides it', () => {
    for (const value of ['', 'on', 'false', '0', 'OFF', '{}']) {
      expect(readLifeSetting(memory({ 'shokuba.officeLife': value })), value).toBe(true)
    }
    expect(readLifeSetting(memory({ 'shokuba.officeLife': 'off' }))).toBe(false)
  })

  it('never throws when the store cannot be used, and leaves it on', () => {
    expect(readLifeSetting(broken)).toBe(true)
    expect(() => writeLifeSetting(broken, false)).not.toThrow()
    expect(() => writeLifeSetting(undefined, false)).not.toThrow()
  })
})
