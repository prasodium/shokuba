import { create } from 'zustand'
import type { Role, RoleInput, RoleUpdate } from '@shared/roles'
import { errorMessage } from '../lib/errors'
import type { Outcome } from '../lib/outcome'

/** What the store needs from the main process. */
export interface RolesApi {
  list(): Promise<Role[]>
  create(input: RoleInput): Promise<Role>
  update(roleId: string, patch: RoleUpdate): Promise<Role>
  duplicate(roleId: string): Promise<Role>
  archive(roleId: string): Promise<void>
  reset(roleId: string): Promise<Role>
}

export interface RolesState {
  roles: Role[]
  refresh(): Promise<void>
  create(input: RoleInput): Promise<Outcome<Role>>
  update(roleId: string, patch: RoleUpdate): Promise<Outcome<Role>>
  duplicate(roleId: string): Promise<Outcome<Role>>
  archive(roleId: string): Promise<Outcome>
  reset(roleId: string): Promise<Outcome<Role>>
}

/** Made from an `api` so it can be tested without a window; the app's own is in `roles.ts`. */
export function createRolesStore(api: RolesApi) {
  return create<RolesState>((set, get) => {
    let inFlight: Promise<void> | undefined
    let again = false

    /** Do something to the roles, read them again, and hand back what came of it. */
    async function attempt<T>(work: () => Promise<T>): Promise<Outcome<T>> {
      try {
        const value = await work()
        await get().refresh()
        return { ok: true, value }
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      }
    }

    return {
      roles: [],

      async refresh() {
        // Requests during a read are folded into one more read afterwards.
        if (inFlight) {
          again = true
          return inFlight
        }
        inFlight = (async () => {
          try {
            do {
              again = false
              set({ roles: await api.list() })
            } while (again)
          } catch {
            // The next event will trigger another attempt.
          } finally {
            inFlight = undefined
          }
        })()
        return inFlight
      },

      create: (input) => attempt(() => api.create(input)),
      update: (roleId, patch) => attempt(() => api.update(roleId, patch)),
      duplicate: (roleId) => attempt(() => api.duplicate(roleId)),
      archive: (roleId) => attempt(() => api.archive(roleId)),
      reset: (roleId) => attempt(() => api.reset(roleId)),
    }
  })
}
