import { create } from 'zustand'
import type { Department, DepartmentInput, DepartmentUpdate } from '@shared/departments'
import type { DepartmentList } from '@shared/ipc/api'
import { errorMessage } from '../lib/errors'
import type { Outcome } from '../lib/outcome'

/** What the store needs from the main process. */
export interface DepartmentsApi {
  list(): Promise<DepartmentList>
  create(input: DepartmentInput): Promise<Department>
  update(departmentId: string, patch: DepartmentUpdate): Promise<Department>
  archive(departmentId: string): Promise<void>
}

export interface DepartmentsState {
  departments: Department[]
  /** How many people are in each department, by id. */
  headcounts: Record<string, number>
  refresh(): Promise<void>
  create(input: DepartmentInput): Promise<Outcome<Department>>
  update(departmentId: string, patch: DepartmentUpdate): Promise<Outcome<Department>>
  archive(departmentId: string): Promise<Outcome>
}

/** Made from an `api` so it can be tested without a window; the app's own is in `departments.ts`. */
export function createDepartmentsStore(api: DepartmentsApi) {
  return create<DepartmentsState>((set, get) => {
    let inFlight: Promise<void> | undefined
    let again = false

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
      departments: [],
      headcounts: {},

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
              const { departments, headcounts } = await api.list()
              set({ departments, headcounts })
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
      update: (departmentId, patch) => attempt(() => api.update(departmentId, patch)),
      archive: (departmentId) => attempt(() => api.archive(departmentId)),
    }
  })
}
