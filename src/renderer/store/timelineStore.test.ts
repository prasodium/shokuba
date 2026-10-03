import { describe, expect, it } from 'vitest'
import type { ShokubaEvent } from '@shared/events/schema'
import { foldReplay, EMPTY_REPLAY } from '../replay/history'
import { generateStream } from '../replay/stream'
import { PAGE, TICK_MS, createTimelineStore, type TimelineDeps } from './timelineStore'

/** A fake clock and timer, and a log served a page at a time. */
function harness(events: ShokubaEvent[], extra: Partial<TimelineDeps> = {}) {
  let now = 0
  let ticking: (() => void) | null = null
  const modes: boolean[] = []
  const emitted: number[] = []
  const emptyEmits: number[] = []
  const pages: number[] = []
  const store = createTimelineStore({
    list: async (afterSeq, limit) => {
      pages.push(afterSeq)
      return events.filter((e) => e.seq > afterSeq).slice(0, limit)
    },
    now: () => now,
    every: (fn) => {
      ticking = fn
      return () => {
        ticking = null
      }
    },
    setReplaying: (on) => modes.push(on),
    emit: (played) => {
      if (played.length === 0) emptyEmits.push(1)
      emitted.push(...played.map((e) => e.seq))
    },
    ...extra,
  })
  return {
    store,
    modes,
    emitted,
    emptyEmits,
    pages,
    get ticking() {
      return ticking !== null
    },
    advance(ms: number) {
      for (let t = 0; t < ms; t += TICK_MS) {
        now += TICK_MS
        ticking?.()
      }
    },
  }
}

const stateAt = (events: ShokubaEvent[], n: number) =>
  events.slice(0, n).reduce(foldReplay, EMPTY_REPLAY)

describe('the timeline', () => {
  it('starts live, with nothing loaded', () => {
    const { store } = harness([])
    expect(store.getState()).toMatchObject({ mode: 'live', events: [], cursor: 0 })
  })

  it('turns the read-only rule on before loading, reads the whole log a page at a time, and opens at the end', async () => {
    const events = generateStream({ seed: 3, length: PAGE * 2 + 7 })
    const h = harness(events)
    const entering = h.store.getState().enter()
    expect(h.modes).toEqual([true])
    expect(h.store.getState().mode).toBe('loading')
    await entering
    expect(h.pages).toEqual([0, events[PAGE - 1]!.seq, events[PAGE * 2 - 1]!.seq])
    const state = h.store.getState()
    expect(state).toMatchObject({ mode: 'replay', cursor: events.length, playing: false })
    expect(state.events).toHaveLength(events.length)
    expect(state.state).toEqual(stateAt(events, events.length))
  })

  it('reads one extra page when the log is an exact number of pages', async () => {
    const h = harness(generateStream({ seed: 3, length: PAGE }))
    await h.store.getState().enter()
    expect(h.pages).toHaveLength(2)
  })

  it('goes back to live, read-only rule off, if the log cannot be read', async () => {
    const h = harness([], {
      list: () => Promise.reject(new Error("Error invoking remote method 'x': Error: disk gone")),
    })
    await h.store.getState().enter()
    expect(h.store.getState()).toMatchObject({
      mode: 'live',
      error: 'Could not read the event log: disk gone',
    })
    expect(h.modes).toEqual([true, false])
  })

  it('drops a load that finishes after leaving', async () => {
    let release: (page: ShokubaEvent[]) => void = () => undefined
    const h = harness([], { list: () => new Promise((resolve) => (release = resolve)) })
    const entering = h.store.getState().enter()
    h.store.getState().exit()
    release(generateStream({ seed: 1, length: 3 }))
    await entering
    expect(h.store.getState().mode).toBe('live')
    expect(h.modes).toEqual([true, false])
  })

  it('does not enter twice', async () => {
    const h = harness(generateStream({ seed: 1, length: 3 }))
    await h.store.getState().enter()
    await h.store.getState().enter()
    expect(h.modes).toEqual([true])
  })

  it('seeks, showing exactly the state at the cursor, and draws nothing it skips', async () => {
    const events = generateStream({ seed: 5, length: 300 })
    const h = harness(events)
    await h.store.getState().enter()
    for (const n of [0, 150, 299, 12, 300]) {
      h.store.getState().seek(n)
      expect(h.store.getState().cursor).toBe(n)
      expect(h.store.getState().state).toEqual(stateAt(events, n))
    }
    expect(h.emitted).toEqual([])
  })

  it('steps: forward draws the one event, back draws nothing', async () => {
    const events = generateStream({ seed: 5, length: 10 })
    const h = harness(events)
    await h.store.getState().enter()
    h.store.getState().seek(4)
    h.store.getState().step(1)
    expect(h.store.getState().cursor).toBe(5)
    expect(h.emitted).toEqual([events[4]!.seq])
    h.store.getState().step(-1)
    expect(h.store.getState().cursor).toBe(4)
    expect(h.emitted).toHaveLength(1)
    // Nothing is handed to the pictures when nothing happened.
    h.store.getState().seek(0)
    h.store.getState().step(-1)
    expect(h.emptyEmits).toEqual([])
  })

  it('plays on its clock, drawing each event once in order, and stops at the end', async () => {
    const events = generateStream({ seed: 9, length: 40 })
    const h = harness(events)
    await h.store.getState().enter()
    h.store.getState().seek(0)
    h.store.getState().setSpeed(16)
    h.store.getState().play()
    expect(h.ticking).toBe(true)
    h.advance(60_000)
    expect(h.store.getState()).toMatchObject({ cursor: 40, playing: false })
    expect(h.emitted).toEqual(events.map((e) => e.seq))
    expect(h.ticking).toBe(false)
  })

  it('pausing stops the clock', async () => {
    const h = harness(generateStream({ seed: 9, length: 40 }))
    await h.store.getState().enter()
    h.store.getState().seek(0)
    h.store.getState().play()
    h.store.getState().pause()
    expect(h.ticking).toBe(false)
    h.advance(10_000)
    expect(h.store.getState().cursor).toBe(0)
  })

  it('playing from the end starts again from the beginning', async () => {
    const h = harness(generateStream({ seed: 9, length: 40 }))
    await h.store.getState().enter()
    h.store.getState().play()
    expect(h.store.getState()).toMatchObject({ playing: true })
    expect(h.store.getState().cursor).toBeLessThanOrEqual(1)
  })

  it('narrows to a mission: the range runs from its first event to its last, and steps go between its events', async () => {
    const events = generateStream({ seed: 11, length: 400 })
    const h = harness(events)
    await h.store.getState().enter()
    h.store.getState().setFilter({ kind: 'mission', id: 'm1' })
    const { matches, range } = h.store.getState()
    expect(matches.length).toBeGreaterThan(2)
    expect(range).toEqual({ from: matches[0], to: matches.at(-1)! + 1 })
    h.store.getState().seek(0)
    expect(h.store.getState().cursor).toBe(matches[0])
    h.store.getState().stepMatch(1)
    expect(h.store.getState().cursor).toBe(matches[0]! + 1)
    h.store.getState().stepMatch(1)
    expect(h.store.getState().cursor).toBe(matches[1]! + 1)
    h.store.getState().stepMatch(1)
    expect(h.store.getState().cursor).toBe(matches[2]! + 1)
    h.store.getState().stepMatch(-1)
    expect(h.store.getState().cursor).toBe(matches[1]! + 1)
    h.store.getState().stepMatch(-1)
    expect(h.store.getState().cursor).toBe(matches[0]! + 1)
    h.store.getState().stepMatch(-1)
    expect(h.store.getState().cursor).toBe(matches[0]! + 1) // nothing earlier
    h.store.getState().setFilter(null)
    expect(h.store.getState()).toMatchObject({ matches: [], range: { from: 0, to: 400 } })
  })

  it('a filter that names nothing keeps the whole log', async () => {
    const h = harness(generateStream({ seed: 11, length: 50 }))
    await h.store.getState().enter()
    h.store.getState().setFilter({ kind: 'employee', id: 'nobody' })
    expect(h.store.getState()).toMatchObject({ matches: [], range: { from: 0, to: 50 } })
  })

  it('leaving forgets the log, stops the clock and turns the read-only rule off', async () => {
    const h = harness(generateStream({ seed: 9, length: 40 }))
    await h.store.getState().enter()
    h.store.getState().seek(0)
    h.store.getState().play()
    h.store.getState().exit()
    expect(h.store.getState()).toMatchObject({ mode: 'live', events: [], playing: false })
    expect(h.ticking).toBe(false)
    expect(h.modes).toEqual([true, false])
    // Controls do nothing once live.
    h.store.getState().play()
    h.store.getState().step(1)
    h.store.getState().stepMatch(1)
    h.store.getState().setFilter({ kind: 'mission', id: 'm1' })
    expect(h.store.getState()).toMatchObject({ mode: 'live', cursor: 0, filter: null })
  })
})
