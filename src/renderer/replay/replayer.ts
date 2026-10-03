/**
 * The playback clock for replay: where the cursor is, whether it is playing, and how fast. It knows
 * only when each event was recorded, never what it was, and it is given the time instead of reading
 * a clock, so it can be tested with a fake one.
 *
 * The cursor counts the events that have happened: 0 is before the first, `length` is after the last.
 */

export const SPEEDS = [1, 4, 16] as const
export type Speed = (typeof SPEEDS)[number]

/**
 * The longest wait between two events at 1x. Agents are often quiet for minutes; replay plays those
 * stretches as at most this long, so it is never stuck on nothing.
 */
export const MAX_GAP_MS = 3_000

/** The most events one tick moves past, so a burst cannot freeze a frame. */
export const MAX_PER_TICK = 500

export interface ReplayerState {
  cursor: number
  playing: boolean
  speed: Speed
}

export class Replayer {
  private cursor = 0
  private playing = false
  private speed: Speed = 1
  /** When the next event is due, while playing. */
  private dueAt: number | null = null

  /**
   * `times` are when each event was recorded (ms), in the order they are played. `from` and `to`
   * bound where the cursor may go, for replaying part of the log.
   */
  constructor(
    private readonly times: readonly number[],
    private from = 0,
    private to = times.length,
  ) {
    this.from = clamp(from, 0, times.length)
    this.to = clamp(to, this.from, times.length)
    this.cursor = this.from
  }

  get state(): ReplayerState {
    return { cursor: this.cursor, playing: this.playing, speed: this.speed }
  }

  get range(): { from: number; to: number } {
    return { from: this.from, to: this.to }
  }

  /** Limit the cursor to part of the log, moving it inside if it was out. */
  setRange(from: number, to: number): void {
    this.from = clamp(from, 0, this.times.length)
    this.to = clamp(to, this.from, this.times.length)
    this.seek(this.cursor)
  }

  play(now: number): void {
    if (this.cursor >= this.to) return
    this.playing = true
    this.dueAt = now + this.waitBefore(this.cursor)
  }

  pause(): void {
    this.playing = false
    this.dueAt = null
  }

  setSpeed(speed: Speed, now: number): void {
    this.speed = speed
    if (this.playing) this.dueAt = now + this.waitBefore(this.cursor)
  }

  /** Jump to a cursor. Playing carries on from there, after that event's wait. */
  seek(cursor: number, now?: number): void {
    this.cursor = clamp(Math.round(cursor), this.from, this.to)
    if (this.cursor >= this.to) this.pause()
    else if (this.playing && now !== undefined) this.dueAt = now + this.waitBefore(this.cursor)
  }

  /** One event back or forward, paused. */
  step(direction: -1 | 1): void {
    this.pause()
    this.seek(this.cursor + direction)
  }

  /**
   * Move the cursor past every event that is due by `now`. Returns the cursor before and after, so
   * the caller can show the events in between as they happen.
   */
  tick(now: number): { from: number; to: number } {
    const start = this.cursor
    let moved = 0
    while (this.playing && this.dueAt !== null && this.dueAt <= now && moved < MAX_PER_TICK) {
      this.cursor += 1
      moved += 1
      if (this.cursor >= this.to) {
        this.pause()
        break
      }
      this.dueAt += this.waitBefore(this.cursor)
    }
    return { from: start, to: this.cursor }
  }

  /** How long to wait, at this speed, before the event at `index` happens. */
  waitBefore(index: number): number {
    if (index <= 0 || index >= this.times.length) return 0
    const gap = (this.times[index] ?? 0) - (this.times[index - 1] ?? 0)
    // A clock that went backwards is no wait at all, never a negative one.
    return clamp(gap, 0, MAX_GAP_MS) / this.speed
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}
