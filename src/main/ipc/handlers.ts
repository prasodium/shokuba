import { homedir } from 'node:os'
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import {
  ConversationActionRequestSchema,
  DepartmentCreateRequestSchema,
  DepartmentIdRequestSchema,
  DepartmentUpdateRequestSchema,
  ConversationIdRequestSchema,
  EmployeeCreateRequestSchema,
  EmployeeIdRequestSchema,
  EmployeeUpdateRequestSchema,
  EventsListRequestSchema,
  MessageSendRequestSchema,
  MissionActionRequestSchema,
  MissionCreateRequestSchema,
  MissionIdRequestSchema,
  MissionUpdateRequestSchema,
  OfficeSaveRequestSchema,
  RepoRootRequestSchema,
  RoleCreateRequestSchema,
  RoleIdRequestSchema,
  RoleUpdateRequestSchema,
  ReviewRequestSchema,
  TaskActionRequestSchema,
  TaskCreateRequestSchema,
  TaskIdRequestSchema,
  TaskUpdateRequestSchema,
  TerminalResizeRequestSchema,
  TerminalWriteRequestSchema,
  type AppInfo,
  type ProviderInfo,
  type TerminalChunk,
} from '@shared/ipc/api'
import { BreakerActionRequestSchema } from '@shared/breaker'
import {
  IssueImportRequestSchema,
  IssuesRequestSchema,
  PlanAskRequestSchema,
  PlanTakeBackRequestSchema,
  PullFollowUpRequestSchema,
  PullOpenRequestSchema,
  PullPreviewRequestSchema,
  PullStatusRequestSchema,
} from '@shared/github'
import { ReviewSettingsSaveSchema } from '@shared/reviews'
import { CheckSettingsSaveSchema } from '@shared/verification'
import { IPC } from '@shared/ipc/channels'
import type { Services } from '../bootstrap'
import type { AgentServices } from '../agents'
import type { PlatformId } from '../platform'
import { isTrustedSenderUrl, type TrustedOrigins } from './trust'

/** How long terminal output is gathered before being sent, so a chatty agent cannot flood IPC. */
const TERMINAL_FLUSH_MS = 16

const registered: string[] = []

/**
 * Register a validated, sender-checked IPC handler. Nothing crosses from renderer to
 * main without passing through here:
 *   1. the sending page must be our own renderer;
 *   2. the payload must match its Zod schema.
 */
function handle<S extends z.ZodType, R>(
  channel: string,
  schema: S,
  trusted: TrustedOrigins,
  fn: (input: z.output<S>, event: IpcMainInvokeEvent) => R,
): void {
  registered.push(channel)
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, raw: unknown) => {
    const senderUrl = event.senderFrame?.url ?? ''
    if (!isTrustedSenderUrl(senderUrl, trusted)) {
      throw new Error(`Rejected "${channel}" from an untrusted sender`)
    }
    const parsed = schema.safeParse(raw)
    if (!parsed.success) throw new Error(`Invalid request for "${channel}"`)
    return fn(parsed.data, event)
  })
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

export function registerIpc(
  services: Services,
  agents: AgentServices,
  platform: PlatformId,
  trusted: TrustedOrigins,
): () => void {
  handle(IPC.appInfo, z.undefined(), trusted, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    platform,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    schemaVersion: services.schemaVersion,
    eventCount: services.events.log.count(),
    homeDirectory: homedir(),
  }))

  handle(
    IPC.eventsList,
    EventsListRequestSchema.default({ afterSeq: 0, limit: 100 }),
    trusted,
    (request) => services.events.log.list(request),
  )

  handle(IPC.providersList, z.undefined(), trusted, async (): Promise<ProviderInfo[]> => {
    const context = { platform, env: process.env, home: homedir() }
    return Promise.all(
      agents.providers.list().map(async (adapter) => ({
        id: adapter.id,
        displayName: adapter.displayName,
        simulated: adapter.capabilities.simulated,
        supportsModelSelection: adapter.capabilities.supportsModelSelection,
        permissionModes: [...adapter.capabilities.permissionModes],
        installation: await adapter.detect(context),
      })),
    )
  })

  handle(IPC.officeGet, z.undefined(), trusted, () => services.office.get())
  handle(IPC.officeSave, OfficeSaveRequestSchema, trusted, (settings) =>
    services.office.save(settings),
  )

  handle(IPC.departmentsList, z.undefined(), trusted, () => ({
    departments: services.departments.list(),
    headcounts: services.departments.headcounts(),
  }))
  handle(IPC.departmentsCreate, DepartmentCreateRequestSchema, trusted, (input) =>
    services.departments.create(input),
  )
  handle(IPC.departmentsUpdate, DepartmentUpdateRequestSchema, trusted, ({ departmentId, patch }) =>
    services.departments.update(departmentId, patch),
  )
  handle(IPC.departmentsArchive, DepartmentIdRequestSchema, trusted, ({ departmentId }) => {
    services.departments.archive(departmentId)
  })

  handle(IPC.rolesList, z.undefined(), trusted, () => services.roles.list())
  handle(IPC.rolesCreate, RoleCreateRequestSchema, trusted, (input) => services.roles.create(input))
  handle(IPC.rolesUpdate, RoleUpdateRequestSchema, trusted, ({ roleId, patch }) =>
    services.roles.update(roleId, patch),
  )
  handle(IPC.rolesDuplicate, RoleIdRequestSchema, trusted, ({ roleId }) =>
    services.roles.duplicate(roleId),
  )
  handle(IPC.rolesArchive, RoleIdRequestSchema, trusted, ({ roleId }) => {
    services.roles.archive(roleId)
  })
  handle(IPC.rolesReset, RoleIdRequestSchema, trusted, ({ roleId }) => services.roles.reset(roleId))

  handle(IPC.employeesList, z.undefined(), trusted, () => agents.employees.list())
  handle(IPC.employeesCreate, EmployeeCreateRequestSchema, trusted, (input) =>
    agents.employees.create(input),
  )
  handle(IPC.employeesUpdate, EmployeeUpdateRequestSchema, trusted, ({ employeeId, patch }) =>
    agents.employees.update(employeeId, patch),
  )
  handle(IPC.employeesArchive, EmployeeIdRequestSchema, trusted, ({ employeeId }) => {
    agents.employees.archive(employeeId)
  })

  handle(IPC.agentsSnapshot, z.undefined(), trusted, () =>
    agents.views.snapshot(agents.employees.list().map((employee) => employee.id)),
  )
  handle(IPC.agentsStart, EmployeeIdRequestSchema, trusted, async ({ employeeId }) => {
    const employee = agents.employees.get(employeeId)
    if (!employee) throw new Error('No such employee')
    await agents.runtime.start(employee)
  })
  handle(IPC.agentsStop, EmployeeIdRequestSchema, trusted, ({ employeeId }) =>
    agents.runtime.stop(employeeId),
  )
  handle(IPC.agentsInterrupt, EmployeeIdRequestSchema, trusted, ({ employeeId }) => {
    agents.runtime.interrupt(employeeId)
  })

  handle(IPC.missionsList, z.undefined(), trusted, () => agents.missions.listMissions())
  handle(IPC.missionsCreate, MissionCreateRequestSchema, trusted, (input) =>
    agents.missions.createMission(input),
  )
  handle(IPC.missionsUpdate, MissionUpdateRequestSchema, trusted, ({ missionId, patch }) =>
    agents.missions.updateMission(missionId, patch),
  )
  handle(IPC.missionsAction, MissionActionRequestSchema, trusted, ({ missionId, action }) =>
    agents.missions.missionAction(missionId, action),
  )
  handle(IPC.missionsArchive, MissionIdRequestSchema, trusted, ({ missionId }) => {
    agents.missions.archiveMission(missionId)
  })
  handle(IPC.missionsBranches, MissionIdRequestSchema, trusted, ({ missionId }) =>
    agents.workspaces.missionBranches(missionId),
  )
  handle(IPC.tasksCreate, TaskCreateRequestSchema, trusted, (input) =>
    agents.missions.createTask(input),
  )
  handle(IPC.tasksUpdate, TaskUpdateRequestSchema, trusted, ({ taskId, patch }) =>
    agents.missions.updateTask(taskId, patch),
  )
  handle(IPC.tasksAction, TaskActionRequestSchema, trusted, ({ taskId, action }) =>
    agents.tasks.action(taskId, action),
  )
  handle(IPC.tasksChanges, TaskIdRequestSchema, trusted, ({ taskId }) =>
    agents.workspaces.changes(taskId),
  )

  // Checks are set per project, and only for a project Shokuba has actually worked in: a path
  // sent from the page is never taken as a place to store settings or run anything.
  const knownProject = (repoRoot: string): string => {
    if (!agents.workspaces.knownRepos().includes(repoRoot)) {
      throw new Error('That project is not one Shokuba has worked in')
    }
    return repoRoot
  }
  handle(IPC.checksGet, RepoRootRequestSchema, trusted, ({ repoRoot }) =>
    agents.checks.get(knownProject(repoRoot)),
  )
  handle(IPC.checksSave, CheckSettingsSaveSchema, trusted, (input) => {
    knownProject(input.repoRoot)
    return agents.checks.save(input)
  })
  handle(IPC.checksSuggest, RepoRootRequestSchema, trusted, ({ repoRoot }) =>
    agents.verification.suggest(knownProject(repoRoot)),
  )
  handle(IPC.checksTask, TaskIdRequestSchema, trusted, ({ taskId }) =>
    agents.verification.forTask(taskId),
  )
  handle(IPC.checksRun, TaskIdRequestSchema, trusted, ({ taskId }) => {
    agents.verification.runNow(taskId)
  })
  handle(IPC.reviewsTask, TaskIdRequestSchema, trusted, ({ taskId }) =>
    agents.reviews.forTask(taskId),
  )
  handle(IPC.reviewsRequest, ReviewRequestSchema, trusted, ({ taskId, reviewerId }) =>
    agents.reviews.request(taskId, reviewerId, 'manual'),
  )
  handle(IPC.reviewsSettingsSave, ReviewSettingsSaveSchema, trusted, (input) => {
    knownProject(input.repoRoot)
    return agents.reviews.saveSettings(input)
  })
  // An evidence pack is saved where the person says, in a dialog the app shows. The page only
  // names the task: a path sent from the page is never a place to write.
  handle(IPC.evidenceExport, TaskIdRequestSchema, trusted, async ({ taskId }, event) => {
    if (!agents.missions.getTask(taskId)) throw new Error('No such task')
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Choose where to save the evidence pack',
      buttonLabel: 'Save the pack here',
      properties: ['openDirectory', 'createDirectory'] as Array<
        'openDirectory' | 'createDirectory'
      >,
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    const chosen = result.canceled ? undefined : result.filePaths[0]
    return chosen ? agents.evidence.export(taskId, chosen) : null
  })
  // GitHub is read through the `gh` the person is signed in with; the page only ever sees the
  // results. Which repository is asked about is checked against the projects, never trusted.
  handle(IPC.githubStatus, z.undefined(), trusted, () => agents.github.status())
  handle(IPC.githubProjects, z.undefined(), trusted, () => agents.github.projects())
  handle(IPC.githubIssues, IssuesRequestSchema, trusted, (input) => agents.github.issues(input))
  handle(IPC.githubImport, IssueImportRequestSchema, trusted, (input) =>
    agents.github.importIssue(input),
  )
  handle(IPC.githubLinks, z.undefined(), trusted, () => agents.github.links())
  // Handing a draft to a manager is the person's decision, and only ever this one thing.
  handle(IPC.githubPlanAsk, PlanAskRequestSchema, trusted, ({ missionId, managerId }) => {
    agents.issuePlanning.ask(missionId, managerId)
  })
  handle(IPC.githubPlanTakeBack, PlanTakeBackRequestSchema, trusted, ({ missionId }) => {
    agents.issuePlanning.takeBack(missionId)
  })
  // Opening a pull request is the one thing that writes to GitHub. The page can only ask for a
  // preview, and then for that exact preview to be carried out.
  handle(IPC.githubPullPreview, PullPreviewRequestSchema, trusted, (input) =>
    agents.pulls.preview(input),
  )
  handle(IPC.githubPullOpen, PullOpenRequestSchema, trusted, (input) => agents.pulls.open(input))
  // Following the pull request only reads GitHub. Making a task from what went wrong is the person's
  // click, and writes only to Shokuba's own missions.
  handle(IPC.githubPullStatus, PullStatusRequestSchema, trusted, (input) =>
    agents.follow.status(input),
  )
  handle(IPC.githubPullFollowUp, PullFollowUpRequestSchema, trusted, (input) =>
    agents.follow.followUp(input),
  )
  handle(IPC.tasksRemove, TaskIdRequestSchema, trusted, ({ taskId }) => {
    agents.missions.removeTask(taskId)
  })

  handle(IPC.messagesList, z.undefined(), trusted, () => agents.messages.listConversations())
  handle(IPC.messagesSend, MessageSendRequestSchema, trusted, (input) =>
    agents.messages.sendFromHuman(input),
  )
  handle(IPC.messagesRead, ConversationIdRequestSchema, trusted, ({ conversationId }) => {
    agents.messages.markRead(conversationId)
  })
  handle(
    IPC.messagesAction,
    ConversationActionRequestSchema,
    trusted,
    ({ conversationId, action }) =>
      action === 'resume'
        ? agents.messages.resume(conversationId)
        : agents.messages.close(conversationId),
  )

  handle(IPC.breakerAction, BreakerActionRequestSchema, trusted, async ({ employeeId, action }) => {
    if (!agents.employees.get(employeeId)) throw new Error('No such employee')
    if (action === 'reset') agents.breaker.reset(employeeId)
    else if (action === 'pause') agents.breaker.pause(employeeId)
    else await agents.breaker.stopAgent(employeeId)
  })

  handle(IPC.terminalWrite, TerminalWriteRequestSchema, trusted, ({ employeeId, data }) => {
    agents.runtime.write(employeeId, data)
  })
  handle(IPC.terminalResize, TerminalResizeRequestSchema, trusted, ({ employeeId, cols, rows }) => {
    agents.runtime.resize(employeeId, cols, rows)
  })
  handle(IPC.terminalReplay, EmployeeIdRequestSchema, trusted, ({ employeeId }) =>
    agents.runtime.replay(employeeId),
  )

  handle(IPC.systemPickDirectory, z.undefined(), trusted, async (_input, event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = {
      properties: ['openDirectory', 'createDirectory'] as Array<
        'openDirectory' | 'createDirectory'
      >,
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  // Push every newly published event to open windows.
  const unsubscribeEvents = services.events.bus.onAny((event) =>
    broadcast(IPC.eventsPublished, event),
  )

  // Terminal output is batched per agent and flushed on a short timer.
  const pending = new Map<string, TerminalChunk>()
  let timer: NodeJS.Timeout | undefined
  const flush = (): void => {
    timer = undefined
    for (const chunk of pending.values()) broadcast(IPC.terminalData, chunk)
    pending.clear()
  }
  const unsubscribeTerminal = agents.runtime.onTerminalData((employeeId, data, offset) => {
    const queued = pending.get(employeeId)
    pending.set(employeeId, { employeeId, data: (queued?.data ?? '') + data, offset })
    timer ??= setTimeout(flush, TERMINAL_FLUSH_MS)
  })

  return () => {
    unsubscribeEvents()
    unsubscribeTerminal()
    if (timer) clearTimeout(timer)
    for (const channel of registered.splice(0)) ipcMain.removeHandler(channel)
  }
}
