import { create } from 'zustand'
import type { AgentView } from '@shared/agents/view'
import type { Employee, EmployeeInput, EmployeeUpdate } from '@shared/employees'
import type { ShokubaEvent } from '@shared/events/schema'
import type { AppInfo, ProviderInfo } from '@shared/ipc/api'
import { errorMessage } from '../lib/errors'
import { foldEvent, foldEvents } from './fold'
import { useEvents } from './events'
import { emitLiveEvent } from './live'
import { useMessages } from './messages'
import { useMissions } from './missions'
import { useRoles } from './roles'

interface OfficeState {
  ready: boolean
  /** A problem worth showing the person (failed start, rejected form...). Dismissable. */
  notice: string | null
  info: AppInfo | null
  providers: ProviderInfo[]
  employees: Employee[]
  views: Record<string, AgentView>
  lastSeq: number
  selectedId: string | null

  /** Load everything and subscribe to live events. Returns a function that unsubscribes. */
  connect(): () => void
  select(id: string | null): void
  dismissNotice(): void
  refreshProviders(): Promise<void>

  /** Forms show these errors themselves (a modal hides the global notice), so they are returned, not thrown. */
  createEmployee(input: EmployeeInput): Promise<{ employee: Employee } | { error: string }>
  updateEmployee(
    id: string,
    patch: EmployeeUpdate,
  ): Promise<{ error: string } | { error?: undefined }>
  archiveEmployee(id: string): Promise<void>
  startAgent(id: string): Promise<void>
  stopAgent(id: string): Promise<void>
  interruptAgent(id: string): Promise<void>
  /** Lift the circuit breaker's restrictions on an agent, or pause it by hand. */
  breakerAction(id: string, action: 'reset' | 'pause'): Promise<void>
}

export const useOffice = create<OfficeState>((set) => {
  /** Run an action that talks to main; show any failure as a notice instead of throwing. */
  async function attempt<T>(action: () => Promise<T>): Promise<T | undefined> {
    try {
      return await action()
    } catch (error) {
      set({ notice: errorMessage(error) })
      return undefined
    }
  }

  async function refreshEmployees(): Promise<void> {
    const employees = await window.shokuba.employees.list()
    set((state) => ({
      employees,
      selectedId:
        state.selectedId && employees.some((e) => e.id === state.selectedId)
          ? state.selectedId
          : (employees[0]?.id ?? null),
    }))
  }

  return {
    ready: false,
    notice: null,
    info: null,
    providers: [],
    employees: [],
    views: {},
    lastSeq: 0,
    selectedId: null,

    connect() {
      let hydrated = false
      let disposed = false
      const buffered: ShokubaEvent[] = []

      const applyLive = (event: ShokubaEvent): void => {
        useEvents.getState().ingest([event])
        // Pictures that react to news (work changing hands) hear it here, and never replay history.
        emitLiveEvent(event)
        set((state) => {
          const next = foldEvent({ views: state.views, lastSeq: state.lastSeq }, event)
          return next.views === state.views && next.lastSeq === state.lastSeq
            ? state
            : { views: next.views, lastSeq: next.lastSeq }
        })
        if (event.type.startsWith('mission.') || event.type.startsWith('task.')) {
          void useMissions.getState().refresh()
        }
        if (event.type.startsWith('role.')) void useRoles.getState().refresh()
        if (event.type.startsWith('message.') || event.type.startsWith('conversation.')) {
          void useMessages.getState().refresh()
        }
        // The roster changes when an employee is created, edited or archived.
        if (event.type === 'agent.created' || event.type === 'employee.updated') {
          void refreshEmployees()
        }
      }

      // Subscribe before loading, so nothing published in between is missed. Events that
      // arrive during loading are held, then replayed on top of the snapshot.
      const unsubscribe = window.shokuba.events.subscribe((event) => {
        if (hydrated) applyLive(event)
        else buffered.push(event)
      })

      void (async () => {
        try {
          const [info, providers, employees, snapshot, history] = await Promise.all([
            window.shokuba.app.info(),
            window.shokuba.providers.list(),
            window.shokuba.employees.list(),
            window.shokuba.agents.snapshot(),
            window.shokuba.events.list({ limit: 200 }),
          ])
          if (disposed) return

          useEvents.getState().ingest(history)
          void useMissions.getState().refresh()
          void useMessages.getState().refresh()
          void useRoles.getState().refresh()
          const views = Object.fromEntries(snapshot.views.map((view) => [view.employeeId, view]))
          const folded = foldEvents({ views, lastSeq: snapshot.lastSeq }, buffered)
          useEvents.getState().ingest(buffered)
          buffered.length = 0
          hydrated = true

          set((state) => ({
            ready: true,
            info,
            providers,
            employees,
            views: folded.views,
            lastSeq: folded.lastSeq,
            selectedId: state.selectedId ?? employees[0]?.id ?? null,
          }))
        } catch (error) {
          if (!disposed)
            set({ ready: true, notice: `Could not reach the main process: ${errorMessage(error)}` })
        }
      })()

      return () => {
        disposed = true
        unsubscribe()
      }
    },

    select: (id) => set({ selectedId: id }),
    dismissNotice: () => set({ notice: null }),

    async refreshProviders() {
      const providers = await attempt(() => window.shokuba.providers.list())
      if (providers) set({ providers })
    },

    async createEmployee(input) {
      try {
        const employee = await window.shokuba.employees.create(input)
        await refreshEmployees()
        set({ selectedId: employee.id })
        return { employee }
      } catch (error) {
        return { error: errorMessage(error) }
      }
    },

    async updateEmployee(id, patch) {
      try {
        await window.shokuba.employees.update(id, patch)
        await refreshEmployees()
        return {}
      } catch (error) {
        return { error: errorMessage(error) }
      }
    },

    async archiveEmployee(id) {
      const done = await attempt(async () => {
        await window.shokuba.employees.archive(id)
        return true
      })
      if (done) await refreshEmployees()
    },

    async startAgent(id) {
      set({ notice: null })
      await attempt(() => window.shokuba.agents.start(id))
    },
    async stopAgent(id) {
      await attempt(() => window.shokuba.agents.stop(id))
    },
    async interruptAgent(id) {
      await attempt(() => window.shokuba.agents.interrupt(id))
    },
    async breakerAction(id, action) {
      await attempt(() => window.shokuba.breaker.action(id, action))
    },
  }
})

export function selectedEmployee(
  state: Pick<OfficeState, 'employees' | 'selectedId'>,
): Employee | undefined {
  return state.employees.find((employee) => employee.id === state.selectedId)
}
