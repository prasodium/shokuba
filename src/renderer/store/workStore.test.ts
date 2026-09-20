import { describe, expect, it } from 'vitest'
import type { TaskReview } from '@shared/reviews'
import type { TaskVerification } from '@shared/verification'
import { createWorkStore } from './workStore'

const verification = (state: string | null): TaskVerification =>
  ({ latest: state ? { state } : null }) as unknown as TaskVerification
const review = (state: string | null): TaskReview =>
  ({
    latest: state ? { state, reviewerId: 'cy', verdict: null } : null,
    outOfDate: false,
  }) as unknown as TaskReview

interface Pending<T> {
  resolve(value: T): void
}

function storeOf(
  checks: (id: string) => Promise<TaskVerification>,
  reviews: (id: string) => Promise<TaskReview>,
) {
  return createWorkStore({ checks: { forTask: checks }, reviews: { forTask: reviews } })
}

describe('the work store', () => {
  it('reads each task’s checks and review together', async () => {
    const store = storeOf(
      async (id) => verification(id === 'a' ? 'passed' : null),
      async () => review('submitted'),
    )
    await store.getState().refresh(['a', 'b'])
    expect(store.getState().byTask).toEqual({
      a: { checks: 'passed', review: { state: 'submitted', reviewerId: 'cy', verdict: null } },
      b: { checks: null, review: { state: 'submitted', reviewerId: 'cy', verdict: null } },
    })
  })

  it('keeps what it knew when a read fails, and still reads the others', async () => {
    const store = storeOf(
      async () => verification('passed'),
      async (id) => {
        if (id === 'bad') throw new Error('gone')
        return review(null)
      },
    )
    store.setState({ byTask: { bad: { checks: 'failed', review: null } } })
    await store.getState().refresh(['bad', 'good'])
    expect(store.getState().byTask['bad']).toEqual({ checks: 'failed', review: null })
    expect(store.getState().byTask['good']).toEqual({ checks: 'passed', review: null })
  })

  it('lets a newer read win over a slower older one', async () => {
    const slow: Pending<TaskVerification>[] = []
    let calls = 0
    const store = storeOf(
      () => {
        calls += 1
        // The first read is left hanging; the second answers at once.
        return calls === 1
          ? new Promise<TaskVerification>((resolve) => slow.push({ resolve }))
          : Promise.resolve(verification('failed'))
      },
      async () => review(null),
    )
    const first = store.getState().refresh(['a'])
    await store.getState().refresh(['a'])
    expect(store.getState().byTask['a']?.checks).toBe('failed')
    slow[0]?.resolve(verification('passed'))
    await first
    expect(store.getState().byTask['a']?.checks).toBe('failed')
  })

  it('forgets tasks other than the ones kept, and ignores a read of one that has gone', async () => {
    const hang: Pending<TaskVerification>[] = []
    const store = storeOf(
      () => new Promise<TaskVerification>((resolve) => hang.push({ resolve })),
      async () => review(null),
    )
    store.setState({
      byTask: {
        keep: { checks: 'passed', review: null },
        drop: { checks: 'failed', review: null },
      },
    })
    const reading = store.getState().refresh(['drop'])
    store.getState().keepOnly(['keep'])
    expect(Object.keys(store.getState().byTask)).toEqual(['keep'])
    hang[0]?.resolve(verification('passed'))
    await reading
    expect(Object.keys(store.getState().byTask)).toEqual(['keep'])
  })

  it('changes nothing when there is nothing to forget', () => {
    const store = storeOf(
      async () => verification(null),
      async () => review(null),
    )
    const before = { keep: { checks: null, review: null } }
    store.setState({ byTask: before })
    store.getState().keepOnly(['keep', 'other'])
    expect(store.getState().byTask).toBe(before)
  })

  it('reads the same task again when asked, and takes the newer answer', async () => {
    let state = 'running'
    const store = storeOf(
      async () => verification(state),
      async () => review(null),
    )
    await store.getState().refresh(['a'])
    expect(store.getState().byTask['a']?.checks).toBe('running')
    state = 'passed'
    await store.getState().refresh(['a'])
    expect(store.getState().byTask['a']?.checks).toBe('passed')
  })
})
