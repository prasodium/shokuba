import { useEffect, useMemo } from 'react'
import { deriveSignals, latestWorkSeq, type OfficeSignals } from '../office/work'
import { useEvents } from './events'
import { useMissions } from './missions'
import { createWorkStore } from './workStore'

export const useWork = createWorkStore({
  checks: { forTask: (taskId) => window.shokuba.checks.forTask(taskId) },
  reviews: { forTask: (taskId) => window.shokuba.reviews.forTask(taskId) },
})

/**
 * What the board, your inbox, the bench and the desks should show. It reads the checks and reviews of
 * the work that is waiting for you, and again whenever one changes.
 */
export function useOfficeSignals(): OfficeSignals {
  const missions = useMissions((s) => s.missions)
  const byTask = useWork((s) => s.byTask)
  const seq = useEvents((s) => latestWorkSeq(s.events))
  const refresh = useWork((s) => s.refresh)
  const keepOnly = useWork((s) => s.keepOnly)

  // A string, so the effect below runs when the set of tasks changes and not on every new array.
  const waiting = useMemo(
    () =>
      missions
        .flatMap((detail) => detail.tasks)
        .filter((task) => task.status === 'submitted')
        .map((task) => task.id)
        .sort()
        .join(','),
    [missions],
  )

  useEffect(() => {
    const ids = waiting === '' ? [] : waiting.split(',')
    keepOnly(ids)
    void refresh(ids)
  }, [waiting, seq, refresh, keepOnly])

  return useMemo(() => deriveSignals(missions, byTask), [missions, byTask])
}
