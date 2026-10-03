import { create } from 'zustand'
import type { ShokubaEvent } from '@shared/events/schema'
import { errorMessage } from '../lib/errors'
import {
  EMPTY_REPLAY,
  ReplayHistory,
  matchingEvents,
  type ReplayFilter,
  type ReplayState,
} from '../replay/history'
import { Replayer, type Speed } from '../replay/replayer'

/** How many events one page of the log holds (the most `events.list` gives). */
export const PAGE = 500
/** A checkpoint every so many events, so seeking back in a long log stays quick (measured: see ARCHITECTURE). */
export const CHECKPOINT_EVERY = 5_000
/** How often a playing replay looks for events that are due. */
export const TICK_MS = 50

export type TimelineMode = 'live' | 'loading' | 'replay'

export interface TimelineState {
  /** Live shows the present. Replay shows a moment of the recorded log, and nothing can act. */
  mode: TimelineMode
  /** How many events have been read so far while loading. */
  loaded: number
  error: string | null
  events: readonly ShokubaEvent[]
  /** How many events have happened at the moment shown (0 is before the first). */
  cursor: number
  playing: boolean
  speed: Speed
  filter: ReplayFilter
  /** Indexes of the events the filter names. */
  matches: readonly number[]
  /** Where the cursor may go: the whole log, or from the filter's first event to its last. */
  range: { from: number; to: number }
  /** What the office, the roster and the log show at the cursor. */
  state: ReplayState

  enter(): Promise<void>
  exit(): void
  play(): void
  pause(): void
  step(direction: -1 | 1): void
  /** To the previous or next event the filter names. */
  stepMatch(direction: -1 | 1): void
  seek(cursor: number): void
  setSpeed(speed: Speed): void
  setFilter(filter: ReplayFilter): void
}

export interface TimelineDeps {
  list(afterSeq: number, limit: number): Promise<ShokubaEvent[]>
  now(): number
  /** Call `fn` every `ms` until the returned function is called. */
  every(fn: () => void, ms: number): () => void
  /** Whether replay's read-only rule is on, for the guard in front of the API. */
  setReplaying(on: boolean): void
  /** Events that happen while playing or stepping forward, to draw them as they happen. */
  emit(events: readonly ShokubaEvent[]): void
}

const LIVE = {
  mode: 'live' as TimelineMode,
  loaded: 0,
  error: null,
  events: [] as readonly ShokubaEvent[],
  cursor: 0,
  playing: false,
  speed: 1 as Speed,
  filter: null as ReplayFilter,
  matches: [] as readonly number[],
  range: { from: 0, to: 0 },
  state: EMPTY_REPLAY,
}

export function createTimelineStore(deps: TimelineDeps) {
  let history: ReplayHistory | null = null
  let replayer: Replayer | null = null
  let stopTicking: (() => void) | null = null
  // Each entry gets a number, so a load that finishes after leaving (or re-entering) is dropped.
  let generation = 0

  return create<TimelineState>((set, get) => {
    function stopClock(): void {
      stopTicking?.()
      stopTicking = null
    }

    /** Show where the replayer is now, and draw the events it moved past by playing. */
    function sync(played?: { from: number; to: number }): void {
      if (!history || !replayer) return
      const { cursor, playing, speed } = replayer.state
      if (played && played.to > played.from) deps.emit(history.events.slice(played.from, played.to))
      set({ cursor, playing, speed, range: replayer.range, state: history.stateAt(cursor) })
      if (!playing) stopClock()
    }

    function startClock(): void {
      if (stopTicking) return
      stopTicking = deps.every(() => {
        if (replayer) sync(replayer.tick(deps.now()))
      }, TICK_MS)
    }

    return {
      ...LIVE,

      async enter() {
        if (get().mode !== 'live') return
        const mine = ++generation
        // Read only from the first moment, before anything has loaded.
        deps.setReplaying(true)
        set({ ...LIVE, mode: 'loading' })
        const events: ShokubaEvent[] = []
        try {
          for (;;) {
            const page = await deps.list(events.at(-1)?.seq ?? 0, PAGE)
            if (mine !== generation) return
            events.push(...page)
            set({ loaded: events.length })
            if (page.length < PAGE) break
          }
        } catch (error) {
          if (mine !== generation) return
          deps.setReplaying(false)
          set({ ...LIVE, error: `Could not read the event log: ${errorMessage(error)}` })
          return
        }
        history = new ReplayHistory(events, CHECKPOINT_EVERY)
        replayer = new Replayer(events.map((event) => Date.parse(event.ts) || 0))
        // Start at the end, where replay and live agree, and go back from there.
        replayer.seek(events.length)
        set({ mode: 'replay', events, loaded: events.length })
        sync()
      },

      exit() {
        generation += 1
        stopClock()
        history = null
        replayer = null
        deps.setReplaying(false)
        set({ ...LIVE })
      },

      play() {
        if (!replayer) return
        // Playing from the very end starts again from the beginning of the range.
        if (replayer.state.cursor >= replayer.range.to) replayer.seek(replayer.range.from)
        replayer.play(deps.now())
        sync()
        if (replayer.state.playing) startClock()
      },

      pause() {
        replayer?.pause()
        sync()
      },

      step(direction) {
        if (!replayer) return
        const from = replayer.state.cursor
        replayer.step(direction)
        // A step forward is one event happening, so it is drawn; a step back moves past nothing.
        sync({ from, to: replayer.state.cursor })
      },

      stepMatch(direction) {
        if (!replayer) return
        const { cursor } = replayer.state
        const { matches } = get()
        // The event at index i has happened once the cursor is i + 1.
        const target =
          direction === 1
            ? matches.find((index) => index + 1 > cursor)
            : [...matches].reverse().find((index) => index + 1 < cursor)
        if (target === undefined) return
        replayer.pause()
        replayer.seek(target + 1)
        sync()
      },

      seek(cursor) {
        replayer?.seek(cursor, deps.now())
        sync()
      },

      setSpeed(speed) {
        replayer?.setSpeed(speed, deps.now())
        sync()
      },

      setFilter(filter) {
        if (!replayer || !history) return
        const matches = matchingEvents(history.events, filter)
        const first = matches[0]
        const last = matches.at(-1)
        if (filter && first !== undefined && last !== undefined) {
          replayer.setRange(first, last + 1)
        } else {
          replayer.setRange(0, history.length)
        }
        set({ filter, matches })
        sync()
      },
    }
  })
}

export type TimelineStore = ReturnType<typeof createTimelineStore>
