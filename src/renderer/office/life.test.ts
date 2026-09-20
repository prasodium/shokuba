import { describe, expect, it } from 'vitest'
import type { RuntimeState } from '@shared/types/agent'
import { BREAK_KINDS, Life, PACE, type BreakKind, type LifeInput, type LifeSubject } from './life'

const T0 = 1_000_000
const NONE = new Set<string>()
const ROOMY = { tea: 3, snacks: 2 } as const

/** A die that rolls these values in turn. */
const dice = (...values: number[]) => {
  let i = 0
  return () => values[i++ % values.length] ?? 0
}

const idle = (id: string, since = T0, state: RuntimeState = 'idle'): LifeSubject => ({
  id,
  state,
  since,
  busy: false,
})

/** Everything settled: idle since T0, and no stagger, so a break starts the moment it can. */
const ready = T0 + PACE.idleMs

const input = (patch: Partial<LifeInput> & { subjects: readonly LifeSubject[] }): LifeInput => ({
  now: ready,
  enabled: true,
  arrived: NONE,
  open: ROOMY,
  ...patch,
})

const kindOf = (on: Map<string, BreakKind>, id: string) => on.get(id)

describe('when someone takes a break', () => {
  it('waits until their agent has been idle long enough', () => {
    const life = new Life(dice(0))
    for (const ms of [0, 1_000, PACE.idleMs - 1]) {
      const on = life.update(input({ now: T0 + ms, subjects: [idle('ada')] }))
      expect(on.size, `${ms}`).toBe(0)
    }
    expect(life.update(input({ subjects: [idle('ada')] })).size).toBe(1)
  })

  it('waits a little longer, by chance, so a quiet office does not empty all at once', () => {
    // The first roll is the wait: half the stagger.
    const life = new Life(dice(0.5, 0))
    const half = PACE.staggerMs / 2
    expect(life.update(input({ subjects: [idle('ada')] })).size).toBe(0)
    expect(life.update(input({ now: ready + half - 1, subjects: [idle('ada')] })).size).toBe(0)
    expect(life.update(input({ now: ready + half, subjects: [idle('ada')] })).size).toBe(1)
  })

  it('draws the wait afresh after a spell of work, and forgets the last one', () => {
    // First wait: a tenth of the stagger. After the spell of work: nine tenths.
    const life = new Life(dice(0.1, 0.9))
    life.update(input({ subjects: [idle('a')] }))
    const worked = ready + 1_000
    life.update(input({ now: worked, subjects: [idle('a', worked, 'coding')] }))
    const back = worked + 1_000
    const subjects = [idle('a', back)]
    const readyAgain = back + PACE.idleMs
    // The first wait would be long over by now; the second is not.
    expect(life.update(input({ now: readyAgain, subjects })).size).toBe(0)
    expect(life.update(input({ now: readyAgain + PACE.staggerMs * 0.5, subjects })).size).toBe(0)
    expect(life.update(input({ now: readyAgain + PACE.staggerMs * 0.9, subjects })).size).toBe(1)
  })

  it('draws that wait once, not again every moment', () => {
    // If it were drawn every tick, the next roll (0) would send them at once.
    const life = new Life(dice(0.9, 0, 0, 0))
    life.update(input({ subjects: [idle('ada')] }))
    for (let ms = 1_000; ms < 20_000; ms += 1_000) {
      expect(life.update(input({ now: ready + ms, subjects: [idle('ada')] })).size, `${ms}`).toBe(0)
    }
  })

  it('happens only while the agent is idle or waiting, and never while it works', () => {
    const states: RuntimeState[] = [
      'offline',
      'starting',
      'thinking',
      'coding',
      'testing',
      'researching',
      'reviewing',
      'blocked',
      'paused',
      'error',
      'stopped',
    ]
    for (const state of states) {
      const life = new Life(dice(0))
      const on = life.update(input({ now: ready + 60_000, subjects: [idle('ada', T0, state)] }))
      expect(on.size, state).toBe(0)
    }
    for (const state of ['idle', 'waiting'] as const) {
      const life = new Life(dice(0))
      expect(life.update(input({ subjects: [idle('ada', T0, state)] })).size, state).toBe(1)
    }
  })

  it('does not happen for someone who has somewhere real to be', () => {
    const life = new Life(dice(0))
    const busy: LifeSubject = { ...idle('ada'), busy: true }
    expect(life.update(input({ subjects: [busy] })).size).toBe(0)
  })

  it('counts the idle time from when the state began, not from when anyone looked', () => {
    const life = new Life(dice(0))
    // They were working until a moment ago.
    expect(life.update(input({ subjects: [idle('ada', ready - 5_000)] })).size).toBe(0)
  })
})

describe('where they go', () => {
  it('goes for tea or coffee on a low roll and a snack on a high one', () => {
    // roll 1: the wait; roll 2: what they fancy.
    const tea = new Life(dice(0, PACE.teaShare - 0.01))
    expect(kindOf(tea.update(input({ subjects: [idle('ada')] })), 'ada')).toBe('tea')
    const snack = new Life(dice(0, PACE.teaShare))
    expect(kindOf(snack.update(input({ subjects: [idle('ada')] })), 'ada')).toBe('snacks')
  })

  it('goes to the other counter when the one they fancied is full', () => {
    const wantsTea = () => new Life(dice(0, 0))
    expect(
      kindOf(wantsTea().update(input({ open: { tea: 0, snacks: 1 }, subjects: [idle('a')] })), 'a'),
    ).toBe('snacks')
    const wantsSnack = () => new Life(dice(0, 0.99))
    expect(
      kindOf(
        wantsSnack().update(input({ open: { tea: 1, snacks: 0 }, subjects: [idle('a')] })),
        'a',
      ),
    ).toBe('tea')
  })

  it('stays at their desk when both counters are full, and tries again later without waiting anew', () => {
    const life = new Life(dice(0, 0))
    expect(life.update(input({ open: { tea: 0, snacks: 0 }, subjects: [idle('a')] })).size).toBe(0)
    expect(life.update(input({ now: ready + 1_000, subjects: [idle('a')] })).size).toBe(1)
  })

  it('does not give two people the last spot at a counter', () => {
    // Six people, so two may be away, and both fancy tea, but there is one place at the tea counter.
    const life = new Life(dice(0))
    const team = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => idle(id))
    const on = life.update(input({ open: { tea: 1, snacks: 0 }, subjects: team }))
    expect([...on.values()]).toEqual(['tea'])
  })

  it('gives the second person the other counter when the first took the last place at theirs', () => {
    const life = new Life(dice(0))
    const team = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => idle(id))
    const on = life.update(input({ open: { tea: 1, snacks: 1 }, subjects: team }))
    expect([...on.values()].sort()).toEqual(['snacks', 'tea'])
  })

  it('only ever names a counter that exists', () => {
    const life = new Life(dice(0, 0.3, 0.8))
    const on = life.update(
      input({ subjects: [idle('a'), idle('b'), idle('c'), idle('d'), idle('e'), idle('f')] }),
    )
    for (const kind of on.values()) expect(BREAK_KINDS).toContain(kind)
  })
})

describe('how many are away at once', () => {
  const team = (n: number) => Array.from({ length: n }, (_, i) => idle(`e${i}`))

  it('is at most a third of the team, and always allows one', () => {
    for (const [size, most] of [
      [1, 1],
      [2, 1],
      [3, 1],
      [5, 1],
      [6, 2],
      [9, 3],
      [12, 4],
    ] as const) {
      const life = new Life(dice(0))
      expect(life.update(input({ subjects: team(size) })).size, `${size}`).toBe(most)
    }
  })

  it('lets someone else go once one is back, not before', () => {
    const life = new Life(dice(0))
    const subjects = team(4)
    expect(life.update(input({ subjects })).size).toBe(1)
    expect(life.update(input({ now: ready + 5_000, subjects })).size).toBe(1)
    // The one away has been at the counter for their stay, and comes back.
    const first = [...life.update(input({ now: ready + 6_000, subjects })).keys()][0] as string
    const there = new Set([first])
    life.update(input({ now: ready + 7_000, subjects, arrived: there }))
    const later = life.update(
      input({ now: ready + 7_000 + PACE.stayMaxMs, subjects, arrived: there }),
    )
    expect(later.has(first)).toBe(false)
    // In that same moment the next in line goes, so it is still one at a time.
    expect(later.size).toBe(1)
  })

  it('sends first whoever’s moment came first, then the roster order', () => {
    const life = new Life(dice(0.5, 0.1, 0.1, 0))
    // b's wait is shorter than a's (0.1 against 0.5), but both are due by the time of the next look.
    const subjects = [idle('a'), idle('b')]
    life.update(input({ subjects }))
    const on = life.update(input({ now: ready + PACE.staggerMs, subjects }))
    expect([...on.keys()]).toEqual(['b'])
  })
})

describe('the end of a break', () => {
  const startBreak = (life: Life, subjects: readonly LifeSubject[]) =>
    life.update(input({ subjects }))

  it('comes after they have stayed a while at the counter, not before', () => {
    // Waits: 0. Kind: 0. Stay: the shortest.
    const life = new Life(dice(0, 0, 0))
    const subjects = [idle('a')]
    startBreak(life, subjects)
    const there = new Set(['a'])
    const arrivedAt = ready + 10_000
    expect(life.update(input({ now: arrivedAt, subjects, arrived: there })).size).toBe(1)
    expect(
      life.update(input({ now: arrivedAt + PACE.stayMinMs - 1, subjects, arrived: there })).size,
    ).toBe(1)
    expect(
      life.update(input({ now: arrivedAt + PACE.stayMinMs, subjects, arrived: there })).size,
    ).toBe(0)
  })

  it('stays as long as the roll says, up to the longest', () => {
    const life = new Life(dice(0, 0, 0.999))
    const subjects = [idle('a')]
    startBreak(life, subjects)
    const there = new Set(['a'])
    life.update(input({ now: ready, subjects, arrived: there }))
    expect(
      life.update(input({ now: ready + PACE.stayMinMs + 1, subjects, arrived: there })).size,
    ).toBe(1)
    expect(life.update(input({ now: ready + PACE.stayMaxMs, subjects, arrived: there })).size).toBe(
      0,
    )
  })

  it('does not start the stay until they are there', () => {
    const life = new Life(dice(0, 0, 0))
    const subjects = [idle('a')]
    startBreak(life, subjects)
    // Long after the stay would have been over, but they have not arrived: the walk still counts.
    expect(life.update(input({ now: ready + PACE.travelMs - 1, subjects })).size).toBe(1)
  })

  it('is given up if they never get there', () => {
    const life = new Life(dice(0, 0, 0))
    const subjects = [idle('a')]
    startBreak(life, subjects)
    expect(life.update(input({ now: ready + PACE.travelMs, subjects })).size).toBe(0)
  })

  it('is over the moment their agent starts working again', () => {
    for (const state of ['thinking', 'coding', 'testing', 'error', 'offline', 'paused'] as const) {
      const life = new Life(dice(0, 0, 0))
      startBreak(life, [idle('a')])
      const back = idle('a', ready + 1_000, state)
      expect(life.update(input({ now: ready + 1_000, subjects: [back] })).size, state).toBe(0)
    }
  })

  it('carries on if their agent goes from idle to waiting', () => {
    const life = new Life(dice(0, 0, 0))
    startBreak(life, [idle('a')])
    const waiting = idle('a', ready + 1_000, 'waiting')
    expect(life.update(input({ now: ready + 1_000, subjects: [waiting] })).size).toBe(1)
  })

  it('is over when they are given somewhere real to be', () => {
    const life = new Life(dice(0, 0, 0))
    startBreak(life, [idle('a')])
    const busy: LifeSubject = { ...idle('a'), busy: true }
    expect(life.update(input({ now: ready + 1_000, subjects: [busy] })).size).toBe(0)
  })

  it('is over for someone who has left the office', () => {
    const life = new Life(dice(0))
    startBreak(life, [idle('a'), idle('b'), idle('c')])
    const on = life.update(input({ now: ready + 1_000, subjects: [idle('b'), idle('c')] }))
    expect(on.has('a')).toBe(false)
  })
})

describe('the next break', () => {
  /** A break that starts, is reached, and ends after the shortest stay. */
  function oneBreak(life: Life, subjects: readonly LifeSubject[]): number {
    life.update(input({ subjects }))
    const there = new Set([subjects[0]?.id ?? ''])
    life.update(input({ now: ready + 1_000, subjects, arrived: there }))
    const over = ready + 1_000 + PACE.stayMinMs
    expect(life.update(input({ now: over, subjects, arrived: there })).size).toBe(0)
    return over
  }

  it('is not for a good while, so nobody goes twice in a row', () => {
    const life = new Life(dice(0))
    const subjects = [idle('a')]
    const over = oneBreak(life, subjects)
    for (const ms of [0, 1_000, PACE.cooldownMs - 1]) {
      expect(life.update(input({ now: over + ms, subjects })).size, `${ms}`).toBe(0)
    }
    expect(life.update(input({ now: over + PACE.cooldownMs, subjects })).size).toBe(1)
  })

  it('waits out the cooldown even after a break cut short by work', () => {
    const life = new Life(dice(0))
    life.update(input({ subjects: [idle('a')] }))
    const worked = ready + 2_000
    life.update(input({ now: worked, subjects: [idle('a', worked, 'coding')] }))
    // Idle again for long enough, but the cooldown has not run out.
    const idleAgain = worked + 1_000
    const subjects = [idle('a', idleAgain)]
    expect(life.update(input({ now: idleAgain + PACE.idleMs, subjects })).size).toBe(0)
    expect(life.update(input({ now: worked + PACE.cooldownMs, subjects })).size).toBe(1)
  })
})

describe('switching it off', () => {
  it('calls everyone back at once, and starts nothing', () => {
    const life = new Life(dice(0))
    const subjects = [idle('a')]
    expect(life.update(input({ subjects })).size).toBe(1)
    expect(life.update(input({ now: ready + 1_000, subjects, enabled: false })).size).toBe(0)
    expect(life.update(input({ now: ready + 60_000, subjects, enabled: false })).size).toBe(0)
  })

  it('does not pick a break up where it left off when it comes back on: it starts afresh', () => {
    // Rolls: the first wait (none), a fancy for tea, then the wait after it comes back on (half).
    const life = new Life(dice(0, 0, 0.5))
    const subjects = [idle('a')]
    expect(life.update(input({ subjects })).size).toBe(1)
    life.update(input({ now: ready + 1_000, subjects, enabled: false }))
    const back = ready + 2_000
    expect(life.update(input({ now: back, subjects })).size).toBe(0)
    expect(life.update(input({ now: back + PACE.staggerMs / 2, subjects })).size).toBe(1)
  })

  it('leaves no cooldown behind for when it comes back on', () => {
    const life = new Life(dice(0))
    const subjects = [idle('a')]
    life.update(input({ subjects }))
    life.update(input({ now: ready + 1_000, subjects, enabled: false }))
    expect(life.update(input({ now: ready + 2_000, subjects })).size).toBe(1)
  })
})

describe('chance', () => {
  it('is the only thing that varies: the same rolls give the same day', () => {
    const run = () => {
      const life = new Life(dice(0.3, 0.7, 0.1, 0.9, 0.5))
      const subjects = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => idle(id))
      const log: string[] = []
      for (let ms = 0; ms < 400_000; ms += 5_000) {
        const there = new Set(subjects.map((s) => s.id))
        const on = life.update(input({ now: T0 + ms, subjects, arrived: there }))
        log.push([...on].map(([id, kind]) => `${id}:${kind}`).join(','))
      }
      return log
    }
    expect(run()).toEqual(run())
    expect(run().some((line) => line !== '')).toBe(true)
  })
})

describe('a whole quiet day', () => {
  /** A small seeded die, so the day is the same every time. */
  function seeded(seed: number): () => number {
    let a = seed
    return () => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  /** Six people idle all day; whoever is on a break reaches the counter eight seconds after setting off. */
  function day(seed: number, minutes: number) {
    const life = new Life(seeded(seed))
    const subjects = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => idle(id))
    const started = new Map<string, number[]>()
    const away = new Map<string, number>()
    let most = 0
    for (let ms = 0; ms <= minutes * 60_000; ms += 1_000) {
      const now = T0 + ms
      const there = new Set([...away].filter(([, since]) => now - since >= 8_000).map(([id]) => id))
      const on = life.update(input({ now, subjects, arrived: there }))
      for (const id of away.keys()) if (!on.has(id)) away.delete(id)
      for (const id of on.keys()) {
        if (!away.has(id)) {
          away.set(id, now)
          started.set(id, [...(started.get(id) ?? []), now])
        }
      }
      most = Math.max(most, on.size)
    }
    return { started, most }
  }

  it('never has more than a third of the team away at once', () => {
    for (const seed of [1, 2, 3, 4, 5]) expect(day(seed, 30).most, `${seed}`).toBeLessThanOrEqual(2)
  })

  it('gives everyone a turn, but not two turns close together', () => {
    for (const seed of [1, 2, 3]) {
      const { started } = day(seed, 30)
      expect(started.size, `${seed}`).toBe(6)
      for (const times of started.values()) {
        for (let i = 1; i < times.length; i += 1) {
          expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(
            PACE.cooldownMs,
          )
        }
      }
    }
  })

  it('spreads the first breaks over a few minutes instead of sending everyone at once', () => {
    for (const seed of [1, 2, 3]) {
      const first = [...day(seed, 10).started.values()].map((times) => times[0] as number)
      const span = Math.max(...first) - Math.min(...first)
      expect(span, `${seed}`).toBeGreaterThan(PACE.staggerMs / 2)
    }
  })

  it('leaves the office quiet most of the time: calm, not constant', () => {
    let awayTime = 0
    let total = 0
    for (const seed of [1, 2, 3]) {
      const { started } = day(seed, 30)
      // Each break is about a walk out, a stay and a walk back: at most a minute and a bit.
      awayTime += [...started.values()].reduce((n, t) => n + t.length, 0) * 60_000
      total += 30 * 60_000 * 6
    }
    expect(awayTime / total).toBeLessThan(0.25)
  })
})
