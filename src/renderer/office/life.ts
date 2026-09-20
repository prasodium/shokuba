import type { RuntimeState } from '@shared/types/agent'

/**
 * The simulated life of the office: employees whose agents are idle take a tea, coffee or snack
 * break, chat at the pantry table, or meet in the meeting room. This is the one thing the office
 * shows that is NOT a picture of something recorded, so it is fenced in:
 *
 *  - it only ever happens while an agent is idle or waiting, never while it is working
 *  - the scene labels every such trip `simulated`, and a chat or meeting shows only an empty "…"
 *    bubble, never words that could be taken for a real message
 *  - it can be switched off, and is off with reduced motion
 *  - it lives only in the picture: nothing here is recorded, and nothing is ever sent to an agent
 *
 * Pure: time and chance are passed in (`random` is any function returning [0, 1)), so every rule is
 * tested with a fake clock and a scripted die. It decides who is out and where, and with whom; the
 * director gives them a spot and the scene walks them there.
 */

/** Somewhere to go alone. */
export type SoloKind = 'tea' | 'snacks'
/** Somewhere to go together. */
export type GatherKind = 'chat' | 'meeting'
export type LifeKind = SoloKind | GatherKind
export const LIFE_KINDS: readonly LifeKind[] = ['tea', 'snacks', 'chat', 'meeting']

/** The calm pace: it feels lived in without pulling the eye from the work. */
export const PACE = {
  /** How long an agent must have been idle (or waiting) before an outing is on the cards. */
  idleMs: 60_000,
  /** Then up to this much longer, drawn at random, so outings spread over a few minutes and do not come in waves. */
  staggerMs: 150_000,
  /** How long they stay once they are all there, between these two, by kind. */
  stayMs: {
    tea: [20_000, 35_000],
    snacks: [20_000, 35_000],
    chat: [25_000, 45_000],
    meeting: [40_000, 70_000],
  } as const satisfies Record<LifeKind, readonly [number, number]>,
  /** Give up on an outing if they have not all got there by now (say, no room). */
  travelMs: 45_000,
  /** After an outing ends, how long before that person can go on another. */
  cooldownMs: 150_000,
  /**
   * What someone fancies, by where a roll from 0 to 1 falls: tea or coffee first, then a snack, then
   * a chat, then (rarely) a meeting. What cannot be had falls back to something simpler.
   */
  mix: { tea: 0.4, snacks: 0.65, chat: 0.9 },
  /** How often a chat is three people rather than two. */
  chatOfThree: 0.3,
  /** A meeting is this many at least, and at most. */
  meetingSize: [3, 5],
  /** A meeting needs a team at least this big, so it takes at most half of them. */
  meetingTeam: 6,
  /** At most this share of the team is away at once (and always one may go). */
  maxAwayShare: 1 / 3,
} as const

/** The only states in which someone is free to go: their agent is not working. */
const FREE: ReadonlySet<RuntimeState> = new Set(['idle', 'waiting'])

/** What life needs to know about one employee. */
export interface LifeSubject {
  id: string
  state: RuntimeState
  /** When the state began, in milliseconds. */
  since: number
  /** They already have somewhere to be for a real reason (a review), so nothing for them. */
  busy: boolean
}

export interface LifeInput {
  now: number
  /** False when life is switched off, or with reduced motion: everyone is called back. */
  enabled: boolean
  subjects: readonly LifeSubject[]
  /** Who is standing at the place they were sent to. */
  arrived: ReadonlySet<string>
  /** How many spots are free at each kind of place right now. */
  open: Readonly<Record<LifeKind, number>>
}

/** Where someone is out to, and with whom. */
export interface Outing {
  kind: LifeKind
  /** Everyone on this outing, the same for each of them (just themselves if it is alone). */
  members: readonly string[]
  /** They are all there: the chat or meeting has begun. */
  together: boolean
}

interface Group {
  kind: LifeKind
  members: string[]
  startedAt: number
  /** Set when they are all there, with when they will head back. */
  leaveAt: number | null
}

interface Track {
  /** When an outing becomes due, once they have been idle long enough; null while it is not on the cards. */
  dueAt: number | null
  group: Group | null
  /** When their last outing ended. */
  endedAt: number
}

/** The fewest a group of this kind can be before it is called off. */
function fewest(kind: LifeKind): number {
  return kind === 'chat' || kind === 'meeting' ? 2 : 1
}

/** What to try, in order, when someone fancies `kind`: it first, then something simpler. */
const FALLBACKS: Record<LifeKind, readonly LifeKind[]> = {
  tea: ['tea', 'snacks', 'chat'],
  snacks: ['snacks', 'tea', 'chat'],
  chat: ['chat', 'tea', 'snacks'],
  meeting: ['meeting', 'chat', 'tea', 'snacks'],
}

export class Life {
  private readonly tracks = new Map<string, Track>()

  constructor(private readonly random: () => number = Math.random) {}

  private between(min: number, max: number): number {
    return min + this.random() * (max - min)
  }

  /** Move on to `now`. Returns who is out, and where and with whom. */
  update(input: LifeInput): Map<string, Outing> {
    const { now, enabled, subjects, arrived } = input
    const present = new Set(subjects.map((s) => s.id))
    for (const id of this.tracks.keys()) if (!present.has(id)) this.tracks.delete(id)

    if (!enabled) {
      // Switched off: nobody is out, and there is no cooldown to wait out when it comes back.
      this.tracks.clear()
      return new Map()
    }

    const byId = new Map(subjects.map((s) => [s.id, s]))
    const isFree = (id: string): boolean => {
      const subject = byId.get(id)
      return subject !== undefined && FREE.has(subject.state) && !subject.busy
    }
    for (const subject of subjects) {
      if (!this.tracks.has(subject.id)) {
        this.tracks.set(subject.id, { dueAt: null, group: null, endedAt: Number.NEGATIVE_INFINITY })
      }
    }

    // 1. Carry on with the outings that are under way, or end them.
    const groups = new Set<Group>()
    for (const track of this.tracks.values()) if (track.group) groups.add(track.group)
    for (const group of groups) this.carryOn(group, now, arrived, isFree)

    // 2. Start new ones for whoever's moment has come.
    const ready = (subject: LifeSubject): boolean => {
      const track = this.tracks.get(subject.id) as Track
      return (
        !track.group &&
        isFree(subject.id) &&
        now - subject.since >= PACE.idleMs &&
        now - track.endedAt >= PACE.cooldownMs
      )
    }
    const due: Array<{ subject: LifeSubject; track: Track; order: number }> = []
    subjects.forEach((subject, order) => {
      const track = this.tracks.get(subject.id) as Track
      if (track.group) return
      if (!ready(subject)) {
        track.dueAt = null
        return
      }
      // Ready: pick a moment, once, so waiting for a free place does not draw again and again.
      track.dueAt ??= now + this.random() * PACE.staggerMs
      if (now >= track.dueAt) due.push({ subject, track, order })
    })
    due.sort((a, b) => (a.track.dueAt ?? 0) - (b.track.dueAt ?? 0) || a.order - b.order)

    const open = { ...input.open }
    let away = [...this.tracks.values()].filter((t) => t.group).length
    const cap = Math.max(1, Math.floor(subjects.length * PACE.maxAwayShare))

    for (const { subject, track } of due) {
      if (track.group) continue // already taken along by someone else's chat
      // Who else could go along: ready, and not already going.
      const partners = subjects.filter((s) => s.id !== subject.id && ready(s))

      const fancy = this.fancy()
      let picked: { kind: LifeKind; size: number } | null = null
      for (const kind of FALLBACKS[fancy]) {
        const size = this.sizeFor(kind, subjects.length, partners.length, open, away, cap)
        if (size > 0) {
          picked = { kind, size }
          break
        }
      }
      if (!picked) continue

      const members = [subject.id]
      const pool = [...partners]
      while (members.length < picked.size && pool.length > 0) {
        const chosen = pool.splice(Math.floor(this.random() * pool.length), 1)[0] as LifeSubject
        members.push(chosen.id)
      }
      const group: Group = { kind: picked.kind, members, startedAt: now, leaveAt: null }
      for (const id of members) {
        const t = this.tracks.get(id) as Track
        t.group = group
        t.dueAt = null
      }
      open[picked.kind] -= members.length
      away += members.length
    }

    const out = new Map<string, Outing>()
    for (const [id, track] of this.tracks) {
      const group = track.group
      if (!group) continue
      out.set(id, {
        kind: group.kind,
        members: [...group.members],
        together: group.leaveAt !== null,
      })
    }
    return out
  }

  /** What someone fancies, from a roll. */
  private fancy(): LifeKind {
    const roll = this.random()
    if (roll < PACE.mix.tea) return 'tea'
    if (roll < PACE.mix.snacks) return 'snacks'
    if (roll < PACE.mix.chat) return 'chat'
    return 'meeting'
  }

  /**
   * How many would go for `kind`, counting the one asking, or 0 if it cannot be had: there must be
   * room at the place, enough others ready to go along, and room for them all among those who may be
   * away (a chat or meeting may take more than a third of a small team, but only if nobody else is out).
   */
  private sizeFor(
    kind: LifeKind,
    team: number,
    others: number,
    open: Readonly<Record<LifeKind, number>>,
    away: number,
    cap: number,
  ): number {
    // Never more than half the team goes together (two may always chat).
    const most = Math.max(2, Math.floor(team / 2))
    let want = 1
    if (kind === 'chat') {
      want = Math.min(this.random() < PACE.chatOfThree ? 3 : 2, most)
    } else if (kind === 'meeting') {
      if (team < PACE.meetingTeam) return 0
      want = Math.floor(this.between(PACE.meetingSize[0], Math.min(PACE.meetingSize[1], most) + 1))
    }
    const size = Math.min(want, 1 + others, open[kind])
    if (size < fewest(kind) || (kind === 'meeting' && size < PACE.meetingSize[0])) return 0
    // A gathering bigger than the limit can go only when nobody else is out.
    return away + size <= Math.max(cap, size) ? size : 0
  }

  /** One outing under way: who has dropped out, whether they are all there, whether it is over. */
  private carryOn(
    group: Group,
    now: number,
    arrived: ReadonlySet<string>,
    isFree: (id: string) => boolean,
  ): void {
    // Anyone whose agent is at work again, or who has somewhere real to be, is back at their desk.
    for (const id of [...group.members]) if (!isFree(id)) this.leave(id, group, now)
    if (group.members.length < fewest(group.kind)) {
      this.dissolve(group, now)
      return
    }
    if (group.leaveAt === null && group.members.every((id) => arrived.has(id))) {
      const [min, max] = PACE.stayMs[group.kind]
      group.leaveAt = now + this.between(min, max)
    }
    const over =
      group.leaveAt !== null ? now >= group.leaveAt : now - group.startedAt >= PACE.travelMs
    if (over) this.dissolve(group, now)
  }

  private leave(id: string, group: Group, now: number): void {
    group.members = group.members.filter((m) => m !== id)
    const track = this.tracks.get(id)
    if (!track) return
    track.group = null
    track.endedAt = now
    track.dueAt = null
  }

  private dissolve(group: Group, now: number): void {
    for (const id of [...group.members]) this.leave(id, group, now)
  }
}

/** How long each person speaks in a chat or meeting before the next takes a turn. */
export const TURN_MS = 2_400

/** Whose turn it is to "speak" at `now`: they take turns, in order, and the empty bubble is theirs. */
export function speaker(members: readonly string[], now: number): string | undefined {
  return members[Math.floor(now / TURN_MS) % members.length]
}
