import type { Services } from '../bootstrap'
import { EmployeeService } from '../employees/service'
import type { Env, PlatformId } from '../platform'
import { createClaudeCodeAdapter } from '../providers/claude-code/adapter'
import { createMockAdapter } from '../providers/mock/adapter'
import { ProviderRegistry } from '../providers/registry'
import { HookServer } from './hook-server'
import type { PtySpawn } from './pty'
import { AgentRuntime } from './runtime'
import { AgentViews } from './views'

export function createDefaultProviders(): ProviderRegistry {
  return new ProviderRegistry([createClaudeCodeAdapter(), createMockAdapter()])
}

export interface AgentServicesOptions {
  platform: PlatformId
  env: Env
  home: string
  providers?: ProviderRegistry
  spawnPty?: PtySpawn
  gracefulStopMs?: number
}

export interface AgentServices {
  providers: ProviderRegistry
  hooks: HookServer
  runtime: AgentRuntime
  employees: EmployeeService
  views: AgentViews
  /** Stops every running agent, then closes the report listener. */
  close(): Promise<void>
}

/**
 * Everything about running agents, layered on the core services. Separate from
 * `createServices` because it starts a listener and (later) processes, which the database
 * and event log do not need.
 */
export async function createAgentServices(
  services: Services,
  options: AgentServicesOptions,
): Promise<AgentServices> {
  const providers = options.providers ?? createDefaultProviders()

  const hooks = new HookServer(services.logger)
  await hooks.listen()

  const runtime = new AgentRuntime({
    events: services.events,
    audit: services.audit,
    providers,
    hooks,
    logger: services.logger,
    platform: options.platform,
    env: options.env,
    home: options.home,
    dataDir: services.dataDir,
    ...(options.spawnPty && { spawnPty: options.spawnPty }),
    ...(options.gracefulStopMs !== undefined && { gracefulStopMs: options.gracefulStopMs }),
  })

  const employees = new EmployeeService({
    db: services.db,
    events: services.events,
    providers,
    platform: options.platform,
    isRunning: (id) => runtime.isRunning(id),
  })

  const views = new AgentViews(
    services.events.bus,
    services.events.log.latestSeq(),
    employees.list().map((employee) => employee.id),
  )

  return {
    providers,
    hooks,
    runtime,
    employees,
    views,
    async close() {
      await runtime.shutdown()
      views.dispose()
      await hooks.close()
    },
  }
}
