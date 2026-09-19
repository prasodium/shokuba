import type { Services } from '../bootstrap'
import { EmployeeService } from '../employees/service'
import { createAgentTools, SHOKUBA_MCP_INSTRUCTIONS } from '../mcp/agent-tools'
import { McpEndpoint } from '../mcp/server'
import { Dispatcher } from '../missions/dispatcher'
import { MissionService } from '../missions/service'
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
  /** Reported to agents connecting to the MCP endpoint. */
  version?: string
  spawnPty?: PtySpawn
  gracefulStopMs?: number
  pasteSettleMs?: number
}

export interface AgentServices {
  providers: ProviderRegistry
  hooks: HookServer
  runtime: AgentRuntime
  employees: EmployeeService
  missions: MissionService
  dispatcher: Dispatcher
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

  // The pieces refer to each other (an agent's tools change tasks; tasks refer to employees;
  // the employee service asks the runtime who is running), so the links are made lazily.
  const missions: MissionService = new MissionService({
    db: services.db,
    events: services.events,
    employeeExists: (id: string): boolean => employees.get(id) !== undefined,
  })
  const mcp = new McpEndpoint(
    {
      name: 'shokuba',
      version: options.version ?? '0.0.0',
      instructions: SHOKUBA_MCP_INSTRUCTIONS,
    },
    createAgentTools(missions),
  )

  const runtime: AgentRuntime = new AgentRuntime({
    events: services.events,
    audit: services.audit,
    providers,
    hooks,
    mcp,
    logger: services.logger,
    platform: options.platform,
    env: options.env,
    home: options.home,
    dataDir: services.dataDir,
    ...(options.spawnPty && { spawnPty: options.spawnPty }),
    ...(options.gracefulStopMs !== undefined && { gracefulStopMs: options.gracefulStopMs }),
    ...(options.pasteSettleMs !== undefined && { pasteSettleMs: options.pasteSettleMs }),
  })

  const employees: EmployeeService = new EmployeeService({
    db: services.db,
    events: services.events,
    providers,
    platform: options.platform,
    isRunning: (id: string): boolean => runtime.isRunning(id),
  })

  // No agent is running yet, so a task still marked in progress was cut off by a restart.
  const cutOff = missions.blockAllInProgress('Shokuba restarted while this was in progress')
  if (cutOff > 0) services.logger.warn('missions.recovered', { blocked: cutOff })

  const dispatcher = new Dispatcher({
    missions,
    delivery: runtime,
    events: services.events,
    logger: services.logger,
  })
  dispatcher.start()

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
    missions,
    dispatcher,
    views,
    async close() {
      dispatcher.stop()
      await runtime.shutdown()
      views.dispose()
      await hooks.close()
    },
  }
}
