import type { RuntimeState } from '@shared/types/agent'
import type { Place, PlaceKind } from './map'

/**
 * Decides who goes where. Pure: given what every agent is doing and what time it is, it says who
 * should be at a shared place and who at their desk. It walks nobody itself and invents nothing:
 * every trip comes from a rule below, or from an errand, and the reason for each is something that
 * really is so: a state the agent is in, or a piece of work Shokuba has given them.
 *
 * What makes it calm rather than twitchy: a state has to last a few seconds before anyone walks
 * (a Bash command that looks like a test run can end in a second, and tool states flicker), and
 * someone who has left that state lingers a moment before they head back, so a state that
 * comes and goes never sends a person to and fro.
 */

/** Why someone should be at a kind of place, and how patiently. */
interface Reason {
  place: PlaceKind
  /** How long the state must have lasted before they set off. */
  enterMs: number
  /** How long it must have been over before they come back. */
  leaveMs: number
}

export interface Rule extends Reason {
  /** The agent state that sends someone to a place. */
  state: RuntimeState
}

/**
 * Why people leave their desks because of what their agent is doing. Running tests is deduced from
 * a command that looks like a test run, which is why the bubble says `inferred` when someone is at
 * the bench for it. (Work Shokuba hands someone is an errand, below, and is a recorded fact.)
 */
export const RULES: readonly Rule[] = [
  { state: 'testing', place: 'qa', enterMs: 3_000, leaveMs: 2_500 },
]

/** States in which nobody is at their desk at all: no one is there to walk. */
const ABSENT: ReadonlySet<RuntimeState> = new Set(['offline', 'stopped', 'paused'])

/** What the director needs to know about one employee. */
export interface Subject {
  id: string
  state: RuntimeState
  /** When the state began, in milliseconds. */
  since: number
  /**
   * A recorded reason to be at this kind of place right now, apart from their state: an independent
   * review in progress sends the reviewer to a reading desk. It comes before any state rule.
   */
  errand?: PlaceKind
}

export interface Assignment {
  placeId: string
  kind: PlaceKind
  /** Which of the place's spots. */
  slot: number
}

export interface Decision {
  /** Where they should be: a place, or null for their desk. */
  target: Assignment | null
  /** Nobody is there to walk (the agent is off), so they are simply at their desk. */
  absent: boolean
  /** The first time this employee has been seen, so they appear where they belong instead of walking. */
  first: boolean
}

interface Hold {
  assignment: Assignment
  reason: Reason
}

export class Director {
  private holds = new Map<string, Hold>()
  private readonly known = new Set<string>()

  constructor(
    private places: readonly Place[],
    private readonly rules: readonly Rule[] = RULES,
  ) {}

  /** The plan changed: keep whoever still has a place there, and let everyone else go home. */
  setPlaces(places: readonly Place[]): void {
    this.places = places
    for (const [id, hold] of this.holds) {
      const place = places.find((p) => p.id === hold.assignment.placeId)
      if (!place || hold.assignment.slot >= place.slots.length) this.holds.delete(id)
    }
  }

  /** Every place-and-spot someone has, so nobody else takes it. */
  private taken(): Set<string> {
    return new Set(
      [...this.holds.values()].map((h) => `${h.assignment.placeId}:${h.assignment.slot}`),
    )
  }

  /** Why this employee should be somewhere other than their desk, if there is a reason. */
  private reasonFor(subject: Subject): Reason | undefined {
    // An errand has no state to wait on: they go, and come back, at once.
    if (subject.errand) return { place: subject.errand, enterMs: 0, leaveMs: 0 }
    return this.rules.find((rule) => rule.state === subject.state)
  }

  /** The first free spot at any place of `kind`, or null if they are all taken. */
  private freeSpot(kind: PlaceKind): Assignment | null {
    const taken = this.taken()
    for (const place of this.places) {
      if (place.kind !== kind) continue
      for (let slot = 0; slot < place.slots.length; slot += 1) {
        if (!taken.has(`${place.id}:${slot}`)) return { placeId: place.id, kind, slot }
      }
    }
    return null
  }

  /**
   * Decide for everyone. `subjects` are in the order the roster lists them; when several want the
   * same place at once, whoever has been waiting longest goes first, then the roster order.
   * With reduced motion nobody goes anywhere.
   */
  update(
    now: number,
    subjects: readonly Subject[],
    options: { reducedMotion?: boolean } = {},
  ): Map<string, Decision> {
    const present = new Set(subjects.map((s) => s.id))
    for (const id of this.holds.keys()) if (!present.has(id)) this.holds.delete(id)
    for (const id of this.known) if (!present.has(id)) this.known.delete(id)

    const decisions = new Map<string, Decision>()
    const waiting: Array<{ subject: Subject; reason: Reason; order: number }> = []

    subjects.forEach((subject, order) => {
      const first = !this.known.has(subject.id)
      this.known.add(subject.id)
      const absent = ABSENT.has(subject.state)
      const held = this.holds.get(subject.id)

      if (options.reducedMotion || absent) {
        this.holds.delete(subject.id)
      } else if (held) {
        const reason = this.reasonFor(subject)
        const stillWanted = reason !== undefined && reason.place === held.reason.place
        // Leaving takes a moment, so a state that comes and goes does not send anyone to and fro.
        if (!stillWanted && now - subject.since >= held.reason.leaveMs)
          this.holds.delete(subject.id)
      } else {
        const reason = this.reasonFor(subject)
        if (reason && now - subject.since >= reason.enterMs)
          waiting.push({ subject, reason, order })
      }
      decisions.set(subject.id, { target: null, absent, first })
    })

    // Give free spots to those who want them, longest-waiting first.
    waiting.sort((a, b) => a.subject.since - b.subject.since || a.order - b.order)
    for (const { subject, reason } of waiting) {
      const spot = this.freeSpot(reason.place)
      if (spot) this.holds.set(subject.id, { assignment: spot, reason })
    }

    for (const [id, decision] of decisions) {
      decisions.set(id, { ...decision, target: this.holds.get(id)?.assignment ?? null })
    }
    return decisions
  }
}
