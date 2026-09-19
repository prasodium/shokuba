import { z } from 'zod'
import type { ShokubaEvent } from '../events/schema'

export const EventsListRequestSchema = z.strictObject({
  afterSeq: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(100),
})
export type EventsListRequest = z.input<typeof EventsListRequestSchema>

export interface AppInfo {
  name: string
  version: string
  platform: 'darwin' | 'win32' | 'linux'
  electronVersion: string
  nodeVersion: string
  schemaVersion: number
  eventCount: number
}

/** The complete surface the preload script exposes to the renderer as `window.shokuba`. */
export interface ShokubaApi {
  app: {
    info(): Promise<AppInfo>
  }
  events: {
    list(request?: EventsListRequest): Promise<ShokubaEvent[]>
    /** Subscribe to newly published events. Returns an unsubscribe function. */
    subscribe(listener: (event: ShokubaEvent) => void): () => void
  }
}
