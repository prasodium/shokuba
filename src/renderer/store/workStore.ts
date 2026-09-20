import { create } from 'zustand'
import type { TaskReview } from '@shared/reviews'
import type { TaskVerification } from '@shared/verification'
import { toTaskWork, type TaskWork } from '../office/work'

/** What the store needs from the main process: where a task's checks and review stand. */
export interface WorkApi {
  checks: { forTask(taskId: string): Promise<TaskVerification> }
  reviews: { forTask(taskId: string): Promise<TaskReview> }
}

export interface WorkState {
  /** Where each task's checks and review stand, as last read. Only submitted tasks are read. */
  byTask: Record<string, TaskWork>
  /** Read these tasks' checks and reviews again. */
  refresh(taskIds: readonly string[]): Promise<void>
  /** Forget everything about tasks other than these, so one that comes back starts afresh. */
  keepOnly(taskIds: readonly string[]): void
}

/** Made from an `api` so it can be tested without a window; the app's own is in `work.ts`. */
export function createWorkStore(api: WorkApi) {
  return create<WorkState>((set) => {
    /** The newest read of each task, so a slow answer never replaces a newer one. */
    const tickets = new Map<string, number>()
    let counter = 0

    async function read(taskId: string): Promise<void> {
      counter += 1
      const ticket = counter
      tickets.set(taskId, ticket)
      try {
        const [verification, review] = await Promise.all([
          api.checks.forTask(taskId),
          api.reviews.forTask(taskId),
        ])
        if (tickets.get(taskId) !== ticket) return
        set((state) => ({
          byTask: { ...state.byTask, [taskId]: toTaskWork(verification, review) },
        }))
      } catch {
        // The next change will read it again; until then the office shows what it last knew.
      }
    }

    return {
      byTask: {},
      async refresh(taskIds) {
        await Promise.all(taskIds.map(read))
      },
      keepOnly(taskIds) {
        const keep = new Set(taskIds)
        set((state) => {
          const stale = Object.keys(state.byTask).filter((id) => !keep.has(id))
          if (stale.length === 0) return state
          // A read still on its way for a task that has gone is ignored when it lands.
          for (const id of stale) tickets.delete(id)
          return {
            byTask: Object.fromEntries(Object.entries(state.byTask).filter(([id]) => keep.has(id))),
          }
        })
      },
    }
  })
}
