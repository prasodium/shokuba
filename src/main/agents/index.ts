import type { Services } from '../bootstrap'
import { EmployeeService } from '../employees/service'
import { createAgentTools, SHOKUBA_MCP_INSTRUCTIONS } from '../mcp/agent-tools'
import { McpEndpoint } from '../mcp/server'
import { MessageRouter } from '../messages/router'
import { MessageService } from '../messages/service'
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

export function createDefaultProviders(env: Env = process.env): ProviderRegistry {
  // Development knobs for the demo agent: how fast it works, and whether it answers every
  // message it receives (used to show the loop protection working).
  const stepMs = Number(env['SHOKUBA_MOCK_STEP_MS'])
  return new ProviderRegistry([
    createClaudeCodeAdapter(),
    createMockAdapter({
      ...(Number.isFinite(stepMs) && stepMs > 0 && { stepMs }),
      chatty: env['SHOKUBA_MOCK_CHATTY'] === '1',
    }),
  ])
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
  messages: MessageService
  router: MessageRouter
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
  const providers = options.providers ?? createDefaultProviders(options.env)

  const hooks = new HookServer(services.logger)
  await hooks.listen()

  // The pieces refer to each other (an agent's tools change tasks; tasks refer to employees;
  // the employee service asks the runtime who is running), so the links are made lazily.
  const missions: MissionService = new MissionService({
    db: services.db,
    events: services.events,
    employeeExists: (id: string): boolean => employees.get(id) !== undefined,
  })
  const team = (): Array<{ id: string; name: string; role: string }> =>
    employees.list().map(({ id, name, role }) => ({ id, name, role }))
  const messages: MessageService = new MessageService({
    db: services.db,
    events: services.events,
    directory: { list: team },
    taskMissionId: (taskId: string): string | undefined => missions.getTask(taskId)?.missionId,
  })
  const router: MessageRouter = new MessageRouter({
    messages,
    delivery: {
      deliveryBlocker: (id: string) => runtime.deliveryBlocker(id),
      deliverPrompt: (id: string, text: string) => runtime.deliverPrompt(id, text),
    },
    directory: { list: team },
    events: services.events,
    logger: services.logger,
  })
  const mcp = new McpEndpoint(
    {
      name: 'shokuba',
      version: options.version ?? '0.0.0',
      instructions: SHOKUBA_MCP_INSTRUCTIONS,
    },
    createAgentTools(missions, messages, {
      list: team,
      isRunning: (id: string) => runtime.isRunning(id),
    }),
  )

  const runtime: AgentRuntime = new AgentRuntime({
    events: services.events,
    audit: services.audit,
    providers,
    hooks,
    mcp,
    onTurnFinished: (employeeId: string, canContinue: boolean) =>
      router.turnEnded(employeeId, canContinue),
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
  // The router starts first, so an idle agent is offered its messages before its next task.
  router.start()
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
    messages,
    router,
    dispatcher,
    views,
    async close() {
      router.stop()
      dispatcher.stop()
      await runtime.shutdown()
      views.dispose()
      await hooks.close()
    },
  }
}
