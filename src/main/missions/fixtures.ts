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
  addEmployee(id: string, name?: string, role?: string, team?: TeamPlace): string
  /** The employees added so far, as the message directory sees them. */
  directory(): Array<{
    id: string
    name: string
    role: string
    isManager: boolean
    reportsTo: string | null
  }>
  eventsOf(...types: string[]): ShokubaEvent[]
  cleanup(): void
}

/** Where an employee sits in a team, for tests. */
export interface TeamPlace {
  isManager?: boolean
  reportsTo?: string | null
}

export function createMissionFixture(): MissionFixture {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'shokuba-missions-')))
  const services = createServices({
    dataDir: dir,
    version: 'test',
    platform: toPlatformId(),
    logger: createLogger(() => {}),
  })
  const employees = new Map<
    string,
    { name: string; role: string; isManager: boolean; reportsTo: string | null }
  >()
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
    addEmployee(id, name = id, role = 'Engineer', team = {}) {
      const isManager = team.isManager ?? false
      const reportsTo = team.reportsTo ?? null
      services.db
        .prepare(
          `INSERT INTO employees (id, name, role, provider_id, working_directory, permission_mode, color, is_manager, reports_to, created_at, updated_at)
           VALUES (@id, @name, @role, 'mock', '/tmp', 'default', '#e8893a', @isManager, @reportsTo, 'now', 'now')`,
        )
        .run({ id, name, role, isManager: isManager ? 1 : 0, reportsTo })
      employees.set(id, { name, role, isManager, reportsTo })
      return id
    },
    directory() {
      return [...employees].map(([id, info]) => ({ id, ...info }))
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
