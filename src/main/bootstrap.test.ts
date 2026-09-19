import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServices, type Services } from './bootstrap'
import { createLogger } from './logging/logger'
import { MIGRATIONS } from './database/migrations'

const dirs: string[] = []
const services: Services[] = []
const quiet = createLogger(() => {})

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'shokuba-test-'))
  dirs.push(dir)
  return dir
}
const start = (dataDir: string): Services => {
  const s = createServices({ dataDir, version: '0.0.1', platform: 'darwin', logger: quiet })
  services.push(s)
  return s
}

afterEach(() => {
  while (services.length > 0) services.pop()?.close()
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('createServices', () => {
  it('migrates a new database and records that the app started', () => {
    const s = start(tempDir())
    expect(s.schemaVersion).toBe(MIGRATIONS.length)
    const events = s.events.log.list()
    expect(events.map((e) => e.type)).toEqual(['app.started'])
    expect(s.audit.list().map((a) => a.action)).toEqual(['app.start'])
  })

  it('creates the data directory if it does not exist', () => {
    const parent = tempDir()
    expect(() => start(join(parent, 'nested', 'deeper'))).not.toThrow()
  })

  it('persists history across a restart', () => {
    const dir = tempDir()
    const first = start(dir)
    first.events.publish({
      type: 'agent.ready',
      source: 'reported',
      payload: { employeeId: 'alice' },
    })
    first.close()

    const second = start(dir)
    const types = second.events.log.list().map((e) => e.type)
    expect(types).toEqual(['app.started', 'agent.ready', 'app.stopping', 'app.started'])
    // seq keeps counting up across restarts instead of starting over.
    const seqs = second.events.log.list().map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('does not re-run migrations on restart', () => {
    const dir = tempDir()
    start(dir).close()
    const applied: unknown[] = []
    const logger = createLogger((_level, line) => {
      const entry = JSON.parse(line) as { event: string }
      if (entry.event === 'database.migrated') applied.push(entry)
    })
    services.push(createServices({ dataDir: dir, version: '0.0.1', platform: 'darwin', logger }))
    expect(applied).toEqual([])
  })

  it('close() is idempotent and publishes app.stopping exactly once', () => {
    const dir = tempDir()
    const s = start(dir)
    s.close()
    expect(() => s.close()).not.toThrow()
    const reopened = start(dir)
    const stops = reopened.events.log.list({ type: 'app.stopping' })
    expect(stops).toHaveLength(1)
  })
})
