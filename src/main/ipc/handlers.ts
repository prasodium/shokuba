import { homedir } from 'node:os'
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import {
  EmployeeCreateRequestSchema,
  EmployeeIdRequestSchema,
  EmployeeUpdateRequestSchema,
  EventsListRequestSchema,
  MissionActionRequestSchema,
  MissionCreateRequestSchema,
  MissionIdRequestSchema,
  MissionUpdateRequestSchema,
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
  handle(IPC.tasksCreate, TaskCreateRequestSchema, trusted, (input) =>
    agents.missions.createTask(input),
  )
  handle(IPC.tasksUpdate, TaskUpdateRequestSchema, trusted, ({ taskId, patch }) =>
    agents.missions.updateTask(taskId, patch),
  )
  handle(IPC.tasksAction, TaskActionRequestSchema, trusted, ({ taskId, action }) =>
    agents.missions.taskAction(taskId, action),
  )
  handle(IPC.tasksRemove, TaskIdRequestSchema, trusted, ({ taskId }) => {
    agents.missions.removeTask(taskId)
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
