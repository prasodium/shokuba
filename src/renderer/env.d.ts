import type { ShokubaApi } from '@shared/ipc/api'

declare global {
  interface Window {
    /** Exposed by src/preload/index.ts. */
    shokuba: ShokubaApi
  }
}

export {}
