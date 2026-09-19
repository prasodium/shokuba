import { create } from 'zustand'
import type {
  Mission,
  MissionAction,
  MissionDetail,
  MissionInput,
  MissionUpdate,
  Task,
  TaskAction,
  TaskInput,
  TaskUpdate,
} from '@shared/missions'
import { errorMessage } from '../lib/errors'

/** Forms show these errors themselves, so mutations return them rather than throw. */
export type Outcome<T = void> = { ok: true; value: T } | { ok: false; error: string }

interface MissionsState {
  missions: MissionDetail[]
  selectedMissionId: string | null
  selectedTaskId: string | null

  refresh(): Promise<void>
  selectMission(id: string | null): void
  selectTask(id: string | null): void

  createMission(input: MissionInput): Promise<Outcome<Mission>>
  updateMission(id: string, patch: MissionUpdate): Promise<Outcome>
  missionAction(id: string, action: MissionAction): Promise<Outcome>
  archiveMission(id: string): Promise<Outcome>
  createTask(input: TaskInput): Promise<Outcome<Task>>
  updateTask(id: string, patch: TaskUpdate): Promise<Outcome>
  taskAction(id: string, action: TaskAction): Promise<Outcome>
  removeTask(id: string): Promise<Outcome>
}

export const useMissions = create<MissionsState>((set, get) => {
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

  /** Keep the selection pointing at something that still exists. */
  function reconcile(missions: MissionDetail[]): Partial<MissionsState> {
    const { selectedMissionId, selectedTaskId } = get()
    const mission =
      missions.find((m) => m.mission.id === selectedMissionId) ??
      missions.find((m) => m.mission.status === 'running') ??
      missions[0]
    const task = mission?.tasks.find((t) => t.id === selectedTaskId)
    return {
      missions,
      selectedMissionId: mission?.mission.id ?? null,
      selectedTaskId: task?.id ?? null,
    }
  }

  return {
    missions: [],
    selectedMissionId: null,
    selectedTaskId: null,

    async refresh() {
      // Requests during a refresh are folded into one more refresh afterwards.
      if (inFlight) {
        again = true
        return inFlight
      }
      inFlight = (async () => {
        try {
          do {
            again = false
            const missions = await window.shokuba.missions.list()
            set(reconcile(missions))
          } while (again)
        } catch {
          // The next event will trigger another attempt.
        } finally {
          inFlight = undefined
        }
      })()
      return inFlight
    },

    selectMission: (id) => set({ selectedMissionId: id, selectedTaskId: null }),
    selectTask: (id) => set({ selectedTaskId: id }),

    async createMission(input) {
      const outcome = await attempt(() => window.shokuba.missions.create(input))
      if (outcome.ok) set({ selectedMissionId: outcome.value.id, selectedTaskId: null })
      return outcome
    },
    updateMission: (id, patch) =>
      attempt(async () => void (await window.shokuba.missions.update(id, patch))),
    missionAction: (id, action) =>
      attempt(async () => void (await window.shokuba.missions.action(id, action))),
    archiveMission: (id) => attempt(() => window.shokuba.missions.archive(id)),
    async createTask(input) {
      const outcome = await attempt(() => window.shokuba.tasks.create(input))
      if (outcome.ok) set({ selectedTaskId: outcome.value.id })
      return outcome
    },
    updateTask: (id, patch) =>
      attempt(async () => void (await window.shokuba.tasks.update(id, patch))),
    taskAction: (id, action) =>
      attempt(async () => void (await window.shokuba.tasks.action(id, action))),
    removeTask: (id) => attempt(() => window.shokuba.tasks.remove(id)),
  }
})

export function selectedMission(
  state: Pick<MissionsState, 'missions' | 'selectedMissionId'>,
): MissionDetail | undefined {
  return state.missions.find((m) => m.mission.id === state.selectedMissionId)
}
