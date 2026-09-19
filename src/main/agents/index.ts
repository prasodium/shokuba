import type { Services } from '../bootstrap'
import { CircuitBreaker } from '../breaker/breaker'
import { EmployeeService } from '../employees/service'
import { EvidenceService } from '../evidence/service'
import { GitError } from '../git/runner'
import { GitService } from '../git/service'
import type { PermissionMode } from '@shared/employees'
import { createAgentTools, SHOKUBA_MCP_INSTRUCTIONS } from '../mcp/agent-tools'
import { McpEndpoint } from '../mcp/server'
import { MessageRouter } from '../messages/router'
import { MessageService } from '../messages/service'
import { Dispatcher } from '../missions/dispatcher'
import { MissionService } from '../missions/service'
import { describeError } from '../logging/logger'
import type { Env, PlatformId } from '../platform'
import { createClaudeCodeAdapter } from '../providers/claude-code/adapter'
import { createMockAdapter } from '../providers/mock/adapter'
import { ProviderRegistry } from '../providers/registry'
import { ReviewService } from '../reviews/service'
import { CheckSettingsStore } from '../verification/settings'
import { VerificationService } from '../verification/service'
import { WorkspaceCleaner } from '../workspaces/cleaner'
import { WorkspaceService } from '../workspaces/service'
import { TaskWorkflow } from '../workspaces/workflow'
import { HookServer } from './hook-server'
import type { PtySpawn } from './pty'
import { AgentLock } from './lock'
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
  /**
   * Git, for giving each task its own branch and working folder. Found on this machine when not
   * given; `false` turns isolation off (tasks then run in the employee's own folder).
   */
  git?: GitService | false
  /** How long to wait for an agent restarted in a task's folder to be ready for input. */
  restartWaitMs?: number
}

/** A real agent (Claude Code) takes a few seconds to start and report in; allow generously. */
const DEFAULT_RESTART_WAIT_MS = 90_000

export interface AgentServices {
  providers: ProviderRegistry
  hooks: HookServer
  runtime: AgentRuntime
  employees: EmployeeService
  missions: MissionService
  messages: MessageService
  router: MessageRouter
  breaker: CircuitBreaker
  dispatcher: Dispatcher
  /** Each task's isolated working folder, and reviewing and merging its work. */
  workspaces: WorkspaceService
  /** What a person's decision on a task does, including merging accepted work. */
  tasks: TaskWorkflow
  /** Removes finished tasks' working folders once no agent is in them. */
  cleaner: WorkspaceCleaner
  /** Does the same for the folders reviewers read in. */
  reviewCleaner: WorkspaceCleaner
  /** The checks a person has set up per project. */
  checks: CheckSettingsStore
  /** Runs those checks on submitted work and keeps the results. */
  verification: VerificationService
  /** Has a different employee read submitted work and report what they found. */
  reviews: ReviewService
  /** Gathers what was recorded about a task's work and exports it as a folder. */
  evidence: EvidenceService
  views: AgentViews
  /** Stops every running agent, then closes the report listener. */
  close(): Promise<void>
}

const pick = (employee: { name: string; role: string } | undefined) =>
  employee ? { name: employee.name, role: employee.role } : null

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

  // Git is what isolates a task's work. Without a usable one, tasks run in the employee's own
  // folder as they always did, and each says why it was not isolated.
  let git: GitService | undefined
  let gitProblem: string | undefined
  if (options.git === false) {
    gitProblem = 'isolation is switched off'
  } else if (options.git) {
    git = options.git
  } else {
    try {
      git = await GitService.locate({
        platform: options.platform,
        env: options.env,
        home: options.home,
        dataDir: services.dataDir,
      })
    } catch (error) {
      gitProblem = error instanceof GitError ? error.message : 'Git could not be used'
      services.logger.warn('git.unavailable', describeError(error))
    }
  }

  // The pieces refer to each other (an agent's tools change tasks; tasks refer to employees;
  // the employee service asks the runtime who is running), so the links are made lazily.
  const missions: MissionService = new MissionService({
    db: services.db,
    events: services.events,
    employeeExists: (id: string): boolean => employees.get(id) !== undefined,
  })
  const team = (): Array<{
    id: string
    name: string
    role: string
    isManager: boolean
    reportsTo: string | null
  }> =>
    employees
      .list()
      .map(({ id, name, role, isManager, reportsTo }) => ({ id, name, role, isManager, reportsTo }))
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
    allowsDelivery: (id: string, fromPerson: boolean) => breaker.allowsDelivery(id, fromPerson),
  })
  const breaker: CircuitBreaker = new CircuitBreaker({
    events: services.events,
    audit: services.audit,
    logger: services.logger,
    port: {
      isRunning: (id: string) => runtime.isRunning(id),
      interrupt: (id: string) => runtime.interrupt(id),
      stop: (id: string) => runtime.stop(id),
    },
    participants: (conversationId: string) => messages.participantsOf(conversationId),
    contactFor: (id: string) => employees.managerOf(id)?.name ?? 'human',
  })
  const mcp = new McpEndpoint(
    {
      name: 'shokuba',
      version: options.version ?? '0.0.0',
      instructions: SHOKUBA_MCP_INSTRUCTIONS,
    },
    createAgentTools(
      missions,
      messages,
      {
        list: team,
        isRunning: (id: string) => runtime.isRunning(id),
        messageBlocker: (id: string) => breaker.messageBlocker(id),
      },
      {
        // The agent is saying it is done: save what is in its working folder as a commit first.
        beforeSubmit: async (task) => {
          await workspaces.commit(task)
        },
        reviews: {
          hasActive: (id: string) => reviews.hasActive(id),
          current: (id: string) => reviews.current(id),
          submit: (id: string, input) => reviews.submit(id, input),
        },
      },
    ),
  )

  const runtime: AgentRuntime = new AgentRuntime({
    events: services.events,
    audit: services.audit,
    providers,
    hooks,
    mcp,
    onTurnFinished: (employeeId: string, canContinue: boolean) =>
      router.turnEnded(employeeId, canContinue),
    teamOf: (id: string) => ({
      manager: pick(employees.managerOf(id)),
      reports: employees.reportsOf(id).map(({ name, role }) => ({ name, role })),
    }),
    decideTool: (employeeId: string, toolName: string, summary: string, toolUseId?: string) =>
      breaker.decide(employeeId, toolName, summary, toolUseId),
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

  const workspaces: WorkspaceService = new WorkspaceService({
    db: services.db,
    events: services.events,
    missions,
    employees: {
      get: (id: string) => {
        const employee = employees.get(id)
        return (
          employee && {
            id: employee.id,
            name: employee.name,
            workingDirectory: employee.workingDirectory,
          }
        )
      },
    },
    git,
    ...(gitProblem && { unavailable: gitProblem }),
    platform: options.platform,
    logger: services.logger,
  })
  const tasks = new TaskWorkflow(missions, workspaces)
  const checks = new CheckSettingsStore({ db: services.db })
  const verification = new VerificationService({
    db: services.db,
    events: services.events,
    audit: services.audit,
    settings: checks,
    git,
    missions,
    workspaces,
    platform: options.platform,
    env: options.env,
    logger: services.logger,
  })
  const cleaner = new WorkspaceCleaner({
    workspaces: {
      pendingRemoval: () =>
        workspaces.pendingRemoval().map(({ task, folder }) => ({ key: task.id, folder })),
      removeFolder: async (taskId: string) => {
        const task = missions.getTask(taskId)
        return task ? workspaces.removeFolder(task) : false
      },
    },
    events: services.events,
    // A folder is in use while an agent works in it, and while a run of checks is using it.
    inUse: () => [...runtime.runningFolders(), ...verification.activeFolders()],
    platform: options.platform,
    logger: services.logger,
  })

  const restartWaitMs = options.restartWaitMs ?? DEFAULT_RESTART_WAIT_MS
  // One agent process per piece of work: stop the running one, start a fresh one in the folder
  // the work is in, and wait until it has reported in and can be handed the briefing.
  const restartIn = async (
    id: string,
    cwd: string,
    launch: { permissionMode?: PermissionMode } = {},
  ): Promise<void> => {
    const employee = employees.get(id)
    if (!employee) throw new Error('That employee no longer exists')
    await runtime.stop(id)
    await runtime.start(employee, {
      cwd,
      ...(launch.permissionMode && { permissionMode: launch.permissionMode }),
    })
    if (!(await runtime.waitUntilDeliverable(id, restartWaitMs))) {
      throw new Error('the agent did not come back ready in time')
    }
  }
  const delivery = {
    deliveryBlocker: (id: string) => runtime.deliveryBlocker(id),
    deliverPrompt: (id: string, text: string) => runtime.deliverPrompt(id, text),
    cwdOf: (id: string) => runtime.cwdOf(id),
    restartIn,
  }

  // Handing out a task and handing out a review both move an agent; never both at once.
  const lock = new AgentLock()
  const reviews: ReviewService = new ReviewService({
    db: services.db,
    events: services.events,
    audit: services.audit,
    git,
    missions,
    employees: { get: (id: string) => employees.get(id) },
    workspaces,
    delivery,
    allows: (id: string) => breaker.allowsTasks(id),
    lock,
    interrupt: (id: string) => runtime.interrupt(id),
    logger: services.logger,
  })
  const reviewCleaner = new WorkspaceCleaner({
    workspaces: {
      pendingRemoval: () => reviews.pendingRemoval(),
      removeFolder: (reviewId: string) => reviews.removeFolder(reviewId),
    },
    events: services.events,
    inUse: () => [...runtime.runningFolders(), ...verification.activeFolders()],
    platform: options.platform,
    logger: services.logger,
  })

  const evidence = new EvidenceService({
    missions,
    employees: {
      get: (id: string) => {
        const employee = employees.get(id)
        return employee && { id: employee.id, name: employee.name, role: employee.role }
      },
    },
    events: services.events.log,
    workspaces,
    git,
    verification,
    reviews,
    audit: services.audit,
    platform: options.platform,
    shokubaVersion: options.version ?? '0.0.0',
    logger: services.logger,
  })

  const dispatcher = new Dispatcher({
    missions,
    delivery,
    events: services.events,
    logger: services.logger,
    allowsTasks: (id: string) => breaker.allowsTasks(id),
    workspaces,
    lock,
    // Someone reading a review is not handed a task until they have handed it in.
    busy: (id: string) => reviews.hasActive(id),
  })
  // The breaker starts first, so it sees an agent's event before anyone acts on it; then the
  // router, so an idle agent is offered its messages before its next task.
  breaker.start()
  router.start()
  dispatcher.start()
  verification.start()
  reviews.start()
  cleaner.start()
  reviewCleaner.start()

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
    breaker,
    dispatcher,
    workspaces,
    tasks,
    cleaner,
    reviewCleaner,
    checks,
    verification,
    reviews,
    evidence,
    views,
    async close() {
      reviewCleaner.stop()
      cleaner.stop()
      reviews.stop()
      verification.stop()
      breaker.stop()
      router.stop()
      dispatcher.stop()
      await runtime.shutdown()
      views.dispose()
      await hooks.close()
    },
  }
}
