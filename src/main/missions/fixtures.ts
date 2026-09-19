import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ShokubaEvent } from '@shared/events/schema'
import { createServices, type Services } from '../bootstrap'
import { createLogger } from '../logging/logger'
import { toPlatformId } from '../platform'
import { MissionService } from './service'

/**
 * A real database with a mission service on top, for tests. Employees are inserted
 * directly (the mission service only needs them to exist), and ids and time are
 * deterministic so assertions stay readable.
 */
export interface MissionFixture {
  services: Services
  missions: MissionService
  addEmployee(id: string): string
  eventsOf(...types: string[]): ShokubaEvent[]
  cleanup(): void
}

export function createMissionFixture(): MissionFixture {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'shokuba-missions-')))
  const services = createServices({
    dataDir: dir,
    version: 'test',
    platform: toPlatformId(),
    logger: createLogger(() => {}),
  })
  const employees = new Set<string>()
  let counter = 0
  let tick = 0

  const missions = new MissionService({
    db: services.db,
    events: services.events,
    employeeExists: (id) => employees.has(id),
    newId: () => `id-${++counter}`,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++tick)),
  })

  return {
    services,
    missions,
    addEmployee(id) {
      services.db
        .prepare(
          `INSERT INTO employees (id, name, role, provider_id, working_directory, permission_mode, color, created_at, updated_at)
           VALUES (@id, @id, 'Engineer', 'mock', '/tmp', 'default', '#e8893a', 'now', 'now')`,
        )
        .run({ id })
      employees.add(id)
      return id
    },
    eventsOf(...types) {
      return services.events.log
        .list({ limit: 1000 })
        .filter((event) => types.length === 0 || types.includes(event.type))
    },
    cleanup() {
      services.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
