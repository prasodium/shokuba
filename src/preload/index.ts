import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ShokubaEvent } from '@shared/events/schema'
import type { ShokubaApi, TerminalChunk } from '@shared/ipc/api'
import { IPC } from '@shared/ipc/channels'

/**
 * The only bridge between the sandboxed renderer and the main process. It exposes a small,
 * explicit API — never `ipcRenderer` itself — and hands listeners the payload only, not
 * the IpcRendererEvent (which would expose the sender).
 */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: ShokubaApi = {
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
  },
  events: {
    list: (request) => ipcRenderer.invoke(IPC.eventsList, request),
    subscribe: (listener) => subscribe<ShokubaEvent>(IPC.eventsPublished, listener),
  },
  providers: {
    list: () => ipcRenderer.invoke(IPC.providersList),
  },
  employees: {
    list: () => ipcRenderer.invoke(IPC.employeesList),
    create: (input) => ipcRenderer.invoke(IPC.employeesCreate, input),
    update: (employeeId, patch) => ipcRenderer.invoke(IPC.employeesUpdate, { employeeId, patch }),
    archive: (employeeId) => ipcRenderer.invoke(IPC.employeesArchive, { employeeId }),
  },
  agents: {
    snapshot: () => ipcRenderer.invoke(IPC.agentsSnapshot),
    start: (employeeId) => ipcRenderer.invoke(IPC.agentsStart, { employeeId }),
    stop: (employeeId) => ipcRenderer.invoke(IPC.agentsStop, { employeeId }),
    interrupt: (employeeId) => ipcRenderer.invoke(IPC.agentsInterrupt, { employeeId }),
  },
  missions: {
    list: () => ipcRenderer.invoke(IPC.missionsList),
    create: (input) => ipcRenderer.invoke(IPC.missionsCreate, input),
    update: (missionId, patch) => ipcRenderer.invoke(IPC.missionsUpdate, { missionId, patch }),
    action: (missionId, action) => ipcRenderer.invoke(IPC.missionsAction, { missionId, action }),
    archive: (missionId) => ipcRenderer.invoke(IPC.missionsArchive, { missionId }),
    branches: (missionId) => ipcRenderer.invoke(IPC.missionsBranches, { missionId }),
  },
  tasks: {
    create: (input) => ipcRenderer.invoke(IPC.tasksCreate, input),
    update: (taskId, patch) => ipcRenderer.invoke(IPC.tasksUpdate, { taskId, patch }),
    action: (taskId, action) => ipcRenderer.invoke(IPC.tasksAction, { taskId, action }),
    remove: (taskId) => ipcRenderer.invoke(IPC.tasksRemove, { taskId }),
    changes: (taskId) => ipcRenderer.invoke(IPC.tasksChanges, { taskId }),
  },
  checks: {
    get: (repoRoot) => ipcRenderer.invoke(IPC.checksGet, { repoRoot }),
    save: (input) => ipcRenderer.invoke(IPC.checksSave, input),
    suggest: (repoRoot) => ipcRenderer.invoke(IPC.checksSuggest, { repoRoot }),
    forTask: (taskId) => ipcRenderer.invoke(IPC.checksTask, { taskId }),
    run: (taskId) => ipcRenderer.invoke(IPC.checksRun, { taskId }),
  },
  reviews: {
    forTask: (taskId) => ipcRenderer.invoke(IPC.reviewsTask, { taskId }),
    request: (taskId, reviewerId) => ipcRenderer.invoke(IPC.reviewsRequest, { taskId, reviewerId }),
    saveSettings: (input) => ipcRenderer.invoke(IPC.reviewsSettingsSave, input),
  },
  messages: {
    list: () => ipcRenderer.invoke(IPC.messagesList),
    send: (input) => ipcRenderer.invoke(IPC.messagesSend, input),
    markRead: (conversationId) => ipcRenderer.invoke(IPC.messagesRead, { conversationId }),
    action: (conversationId, action) =>
      ipcRenderer.invoke(IPC.messagesAction, { conversationId, action }),
  },
  breaker: {
    action: (employeeId, action) => ipcRenderer.invoke(IPC.breakerAction, { employeeId, action }),
  },
  terminal: {
    write: (employeeId, data) => ipcRenderer.invoke(IPC.terminalWrite, { employeeId, data }),
    resize: (employeeId, cols, rows) =>
      ipcRenderer.invoke(IPC.terminalResize, { employeeId, cols, rows }),
    replay: (employeeId) => ipcRenderer.invoke(IPC.terminalReplay, { employeeId }),
    subscribe: (listener) => subscribe<TerminalChunk>(IPC.terminalData, listener),
  },
  system: {
    pickDirectory: () => ipcRenderer.invoke(IPC.systemPickDirectory),
  },
}

contextBridge.exposeInMainWorld('shokuba', api)
