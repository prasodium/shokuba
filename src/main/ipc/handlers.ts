import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { IPC } from '@shared/ipc/channels'
import { EventsListRequestSchema, type AppInfo } from '@shared/ipc/api'
import type { Services } from '../bootstrap'
import type { PlatformId } from '../platform'
import { isTrustedSenderUrl, type TrustedOrigins } from './trust'

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
  fn: (input: z.output<S>) => R,
): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, raw: unknown) => {
    const senderUrl = event.senderFrame?.url ?? ''
    if (!isTrustedSenderUrl(senderUrl, trusted)) {
      throw new Error(`Rejected "${channel}" from an untrusted sender`)
    }
    const parsed = schema.safeParse(raw)
    if (!parsed.success) throw new Error(`Invalid request for "${channel}"`)
    return fn(parsed.data)
  })
}

export function registerIpc(
  services: Services,
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
  }))

  handle(
    IPC.eventsList,
    EventsListRequestSchema.default({ afterSeq: 0, limit: 100 }),
    trusted,
    (request) => services.events.log.list(request),
  )

  // Push every newly published event to open windows.
  const unsubscribe = services.events.bus.onAny((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.eventsPublished, event)
    }
  })

  return () => {
    unsubscribe()
    ipcMain.removeHandler(IPC.appInfo)
    ipcMain.removeHandler(IPC.eventsList)
  }
}
