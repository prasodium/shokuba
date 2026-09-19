import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ShokubaEvent } from '@shared/events/schema'
import type { ShokubaApi } from '@shared/ipc/api'
import { IPC } from '@shared/ipc/channels'

/**
 * The only bridge between the sandboxed renderer and the main process. It exposes a small,
 * explicit API — never `ipcRenderer` itself — and hands listeners the payload only, not
 * the IpcRendererEvent (which would expose the sender).
 */
const api: ShokubaApi = {
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
  },
  events: {
    list: (request) => ipcRenderer.invoke(IPC.eventsList, request),
    subscribe: (listener) => {
      const handler = (_event: IpcRendererEvent, published: ShokubaEvent): void =>
        listener(published)
      ipcRenderer.on(IPC.eventsPublished, handler)
      return () => {
        ipcRenderer.removeListener(IPC.eventsPublished, handler)
      }
    },
  },
}

contextBridge.exposeInMainWorld('shokuba', api)
