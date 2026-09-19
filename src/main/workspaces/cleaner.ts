import { promises as fs } from 'node:fs'
import type { EventType, ShokubaEvent } from '@shared/events/schema'
import type { EventStore } from '../events/store'
import { describeError, type Logger } from '../logging/logger'
import { isPathInside, type PlatformId } from '../platform'

/**
 * What the cleaner needs from whoever owns working folders (a task's, a review's): which folders
 * are due to be removed, and a way to remove one. `key` says which owner a folder belongs to.
 */
export interface Removals {
  pendingRemoval(): Array<{ key: string; folder: string }>
  removeFolder(key: string): Promise<boolean>
}

/** Events after which a folder might have become removable. */
const TRIGGERS: ReadonlySet<EventType> = new Set([
  'task.status.changed',
  'review.changed',
  'agent.started',
  'agent.stopped',
])

/**
 * Removes the working folders of finished tasks. A folder goes once its task is done or
 * cancelled and **no running agent is working in it**: that is when its agent has moved on to
 * its next task or been stopped, and at startup, when none is running. It never restarts an
 * agent just to delete a folder, and a running process inside a folder would in any case keep it
 * from being deleted on Windows. The task's branch stays.
 */
export class WorkspaceCleaner {
  private unsubscribe: (() => void) | undefined
  private stopped = false
  private running = false
  private again = false

  constructor(
    private readonly deps: {
      workspaces: Removals
      events: EventStore
      /** The folders running agents were started in. */
      inUse: () => string[]
      platform: PlatformId
      logger: Logger
    },
  ) {}

  start(): void {
    if (this.unsubscribe) return
    this.stopped = false
    this.unsubscribe = this.deps.events.bus.onAny((event: ShokubaEvent) => {
      if (TRIGGERS.has(event.type)) this.schedule()
    })
    // Whatever earlier runs left behind, now that nothing is running.
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  private schedule(): void {
    queueMicrotask(() => {
      if (this.unsubscribe) this.sweep().catch((error: unknown) => this.log(error))
    })
  }

  /** Remove every folder that is due. Passes never overlap; requests during one are coalesced. */
  async sweep(): Promise<number> {
    if (this.running) {
      this.again = true
      return 0
    }
    this.running = true
    let removed = 0
    try {
      do {
        this.again = false
        removed += await this.pass()
      } while (this.again && !this.stopped)
    } finally {
      this.running = false
    }
    return removed
  }

  private async pass(): Promise<number> {
    const { workspaces, platform } = this.deps
    let removed = 0
    for (const { key, folder } of workspaces.pendingRemoval()) {
      if (this.stopped) break
      // Re-read who is running each time: an agent may have started or stopped since the last one.
      // The same place can be spelled two ways (a symbolic link, a short Windows name), and the
      // agent's folder is reported resolved, so compare against the resolved folder as well.
      const real = await resolved(folder)
      const occupied = this.deps
        .inUse()
        .some((cwd) => isPathInside(folder, cwd, platform) || isPathInside(real, cwd, platform))
      if (occupied) continue
      try {
        if (await workspaces.removeFolder(key)) removed += 1
      } catch (error) {
        this.log(error)
      }
    }
    return removed
  }

  private log(error: unknown): void {
    this.deps.logger.error('workspace.cleanup.failed', describeError(error))
  }
}

/** The folder as it really is on disk, or as given if it is already gone. */
async function resolved(folder: string): Promise<string> {
  try {
    return await fs.realpath(folder)
  } catch {
    return folder
  }
}
