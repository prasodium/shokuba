import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_OFFICE_SETTINGS, type OfficeSettings } from '@shared/office'
import { createServices, type Services } from '../bootstrap'
import { createLogger } from '../logging/logger'
import { toPlatformId } from '../platform'
import { OfficeError, type OfficeService } from './service'

let dir: string
let services: Services
let office: OfficeService

const open = () =>
  createServices({
    dataDir: join(dir, 'data'),
    version: 'test',
    platform: toPlatformId(),
    logger: createLogger(() => {}),
  })

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'shokuba-office-')))
  services = open()
  office = services.office
})

afterEach(() => {
  services.close()
  rmSync(dir, { recursive: true, force: true })
})

const custom: OfficeSettings = {
  ...DEFAULT_OFFICE_SETTINGS,
  name: 'Acme Studio',
  floors: { ...DEFAULT_OFFICE_SETTINGS.floors, open: 'oak', lab: 'charcoal' },
  wall: 'sky',
  windows: false,
  names: { ...DEFAULT_OFFICE_SETTINGS.names, inbox: 'Desk' },
}

const events = () => services.events.log.list({ type: 'office.updated' })

describe('OfficeService.get', () => {
  it('is the office as it has always looked, until it is changed', () => {
    expect(office.get()).toEqual(DEFAULT_OFFICE_SETTINGS)
  })

  it('shows the defaults, and does not break, if what is stored cannot be read', () => {
    for (const stored of ['not json', '{}', '[]', JSON.stringify({ ...custom, wall: 'nope' })]) {
      services.db
        .prepare(
          `INSERT INTO office_settings (id, data, updated_at) VALUES (1, @data, 't')
           ON CONFLICT (id) DO UPDATE SET data = @data`,
        )
        .run({ data: stored })
      expect(office.get(), stored).toEqual(DEFAULT_OFFICE_SETTINGS)
    }
  })
})

describe('OfficeService.save', () => {
  it('keeps everything it is given, and reads it back', () => {
    expect(office.save(custom)).toEqual(custom)
    expect(office.get()).toEqual(custom)
  })

  it('trims the names it is given', () => {
    const saved = office.save({
      ...custom,
      name: '  Acme  ',
      names: { ...custom.names, inbox: ' Desk ' },
    })
    expect(saved.name).toBe('Acme')
    expect(saved.names.inbox).toBe('Desk')
  })

  it('records which parts changed, and no more, and never the names themselves', () => {
    office.save(custom)
    const [event] = events()
    expect(event).toMatchObject({
      source: 'user',
      payload: { fields: ['name', 'floors', 'wall', 'windows', 'names'] },
    })
    expect(JSON.stringify(event)).not.toContain('Acme')
    expect(JSON.stringify(event)).not.toContain('Desk')

    office.save({ ...custom, plants: false })
    expect(events().at(-1)).toMatchObject({ payload: { fields: ['plants'] } })
  })

  it('does nothing, and says nothing, when nothing would change', () => {
    expect(office.save(DEFAULT_OFFICE_SETTINGS)).toEqual(DEFAULT_OFFICE_SETTINGS)
    expect(events()).toEqual([])
    office.save(custom)
    const before = events().length
    expect(office.save({ ...custom })).toEqual(custom)
    expect(events()).toHaveLength(before)
  })

  it('can go back to the defaults', () => {
    office.save(custom)
    expect(office.save(DEFAULT_OFFICE_SETTINGS)).toEqual(DEFAULT_OFFICE_SETTINGS)
    expect(office.get()).toEqual(DEFAULT_OFFICE_SETTINGS)
  })

  it('refuses what is not one of the choices, and changes nothing', () => {
    const bad: unknown[] = [
      { ...custom, wall: '#ffffff' },
      { ...custom, floors: { ...custom.floors, open: 'lava' } },
      { ...custom, names: { ...custom.names, tea: 'x'.repeat(31) } },
      { ...custom, name: `a${String.fromCharCode(0)}b` },
      { ...custom, plants: 'yes' },
      { ...custom, extra: 1 },
      {},
      null,
    ]
    for (const settings of bad) {
      expect(() => office.save(settings), JSON.stringify(settings)).toThrow(OfficeError)
    }
    expect(office.get()).toEqual(DEFAULT_OFFICE_SETTINGS)
    expect(events()).toEqual([])
  })

  it('says what was wrong in words', () => {
    try {
      office.save({ ...custom, wall: 'nope' })
      throw new Error('expected a refusal')
    } catch (error) {
      expect((error as Error).message).toContain('wall')
    }
  })

  it('survives a restart', () => {
    office.save(custom)
    services.close()
    services = open()
    office = services.office
    expect(office.get()).toEqual(custom)
  })
})
