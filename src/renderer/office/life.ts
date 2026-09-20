import type { RuntimeState } from '@shared/types/agent'

/**
 * The simulated life of the office: employees whose agents are idle take a tea, coffee or snack
 * break. This is the one thing the office shows that is NOT a picture of something recorded, so it
 * is fenced in:
 *
 *  - it only ever happens while an agent is idle or waiting, never while it is working
 *  - the scene labels every such trip `simulated`
 *  - it can be switched off, and is off with reduced motion
 *  - it lives only in the picture: nothing here is recorded, and nothing is ever sent to an agent
 *
 * Pure: time and chance are passed in (`random` is any function returning [0, 1)), so every rule is
 * tested with a fake clock and a scripted die. It decides who is on a break and where; the director
 * gives them a spot and the scene walks them there.
 */

export type BreakKind = 'tea' | 'snacks'
export const BREAK_KINDS: readonly BreakKind[] = ['tea', 'snacks']

/** The calm pace: it feels lived in without pulling the eye from the work. */
export const PACE = {
  /** How long an agent must have been idle (or waiting) before a break is on the cards. */
  idleMs: 60_000,
  /** Then up to this much longer, drawn at random, so breaks spread over a few minutes and do not come in waves. */
  staggerMs: 150_000,
  /** How long they stay at the counter once they are there, between these two. */
  stayMinMs: 20_000,
  stayMaxMs: 35_000,
  /** Give up on a break if they have not got there by now (say, no room). */
  travelMs: 45_000,
  /** After one break ends, how long before that person can go on another. */
  cooldownMs: 150_000,
  /** How many prefer tea or coffee to a snack. */
  teaShare: 0.6,
  /** At most this share of the team is away at once (and always one may go). */
  maxAwayShare: 1 / 3,
} as const

/** The only states in which someone is free to take a break: their agent is not working. */
const FREE: ReadonlySet<RuntimeState> = new Set(['idle', 'waiting'])

/** What life needs to know about one employee. */
export interface LifeSubject {
  id: string
  state: RuntimeState
  /** When the state began, in milliseconds. */
  since: number
  /** They already have somewhere to be for a real reason (a review), so no break for them. */
  busy: boolean
}

export interface LifeInput {
  now: number
  /** False when life is switched off, or with reduced motion: everyone is called back. */
  enabled: boolean
  subjects: readonly LifeSubject[]
  /** Who is standing at the place they were sent to. */
  arrived: ReadonlySet<string>
  /** How many spots are free at each counter right now. */
  open: Readonly<Record<BreakKind, number>>
}

interface Break {
  kind: BreakKind
  startedAt: number
  /** Set on arriving, with when they will head back. */
  leaveAt: number | null
}

interface Track {
  /** When a break becomes due, once they have been idle long enough; null while it is not on the cards. */
  dueAt: number | null
  on: Break | null
  /** When their last break ended. */
  endedAt: number
}

export class Life {
  private readonly tracks = new Map<string, Track>()

  constructor(private readonly random: () => number = Math.random) {}

  private between(min: number, max: number): number {
    return min + this.random() * (max - min)
  }

  /** Move on to `now`. Returns who is on a break, and at which counter. */
  update(input: LifeInput): Map<string, BreakKind> {
    const { now, enabled, subjects, arrived } = input
    const present = new Set(subjects.map((s) => s.id))
    for (const id of this.tracks.keys()) if (!present.has(id)) this.tracks.delete(id)

    if (!enabled) {
      // Switched off: nobody is on a break, and there is no cooldown to wait out when it comes back.
      this.tracks.clear()
      return new Map()
    }

    const open = { ...input.open }
    const candidates: Array<{ track: Track; order: number }> = []

    subjects.forEach((subject, order) => {
      let track = this.tracks.get(subject.id)
      if (!track) {
        track = { dueAt: null, on: null, endedAt: Number.NEGATIVE_INFINITY }
        this.tracks.set(subject.id, track)
      }
      const free = FREE.has(subject.state) && !subject.busy

      if (track.on) {
        if (!free) {
          // Their agent is at work again, or they have somewhere real to be: back to the desk.
          this.end(track, now)
        } else if (arrived.has(subject.id)) {
          if (track.on.leaveAt === null) {
            track.on.leaveAt = now + this.between(PACE.stayMinMs, PACE.stayMaxMs)
          }
          if (now >= track.on.leaveAt) this.end(track, now)
        } else if (now - track.on.startedAt >= PACE.travelMs) {
          this.end(track, now)
        }
        return
      }

      const ready =
        free && now - subject.since >= PACE.idleMs && now - track.endedAt >= PACE.cooldownMs
      if (!ready) {
        track.dueAt = null
        return
      }
      // Ready: pick a moment, once, so waiting for a free counter does not draw again and again.
      track.dueAt ??= now + this.random() * PACE.staggerMs
      if (now >= track.dueAt) candidates.push({ track, order })
    })

    // Who is away already, and how many may be.
    let away = [...this.tracks.values()].filter((t) => t.on).length
    const cap = Math.max(1, Math.floor(subjects.length * PACE.maxAwayShare))

    // Those whose moment came first go first.
    candidates.sort((a, b) => (a.track.dueAt ?? 0) - (b.track.dueAt ?? 0) || a.order - b.order)
    for (const { track } of candidates) {
      if (away >= cap) break
      const liking: BreakKind = this.random() < PACE.teaShare ? 'tea' : 'snacks'
      const other: BreakKind = liking === 'tea' ? 'snacks' : 'tea'
      const kind = [liking, other].find((k) => open[k] > 0)
      if (!kind) continue
      open[kind] -= 1
      track.on = { kind, startedAt: now, leaveAt: null }
      track.dueAt = null
      away += 1
    }

    const on = new Map<string, BreakKind>()
    for (const [id, track] of this.tracks) if (track.on) on.set(id, track.on.kind)
    return on
  }

  private end(track: Track, now: number): void {
    track.on = null
    track.endedAt = now
    track.dueAt = null
  }
}
