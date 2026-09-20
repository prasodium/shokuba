import { describe, expect, it } from 'vitest'
import type { RuntimeState } from '@shared/types/agent'
import {
  LIFE_KINDS,
  Life,
  PACE,
  TURN_MS,
  speaker,
  type LifeInput,
  type LifeKind,
  type LifeSubject,
} from './life'

const T0 = 1_000_000
const NONE = new Set<string>()
const ROOMY = { tea: 3, snacks: 2, chat: 4, meeting: 6 } as const
const NO_ROOM = { tea: 0, snacks: 0, chat: 0, meeting: 0 } as const

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

const kindOf = (on: Map<string, { kind: LifeKind }>, id: string) => on.get(id)?.kind

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
    const tea = new Life(dice(0, PACE.mix.tea - 0.01))
    expect(kindOf(tea.update(input({ subjects: [idle('ada')] })), 'ada')).toBe('tea')
    const snack = new Life(dice(0, PACE.mix.tea))
    expect(kindOf(snack.update(input({ subjects: [idle('ada')] })), 'ada')).toBe('snacks')
  })

  it('goes for a chat at the roll where snacks end, and a meeting at the roll where chats end', () => {
    const team6 = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => idle(id))
    const chat = new Life(dice(0, 0, 0, 0, 0, 0, PACE.mix.snacks, 0.9))
    expect(kindOf(chat.update(input({ subjects: team6 })), 'a')).toBe('chat')
    const meeting = new Life(dice(0, 0, 0, 0, 0, 0, PACE.mix.chat, 0))
    expect(kindOf(meeting.update(input({ subjects: team6 })), 'a')).toBe('meeting')
    // A hair below each is the one before.
    const snack = new Life(dice(0, 0, 0, 0, 0, 0, PACE.mix.snacks - 0.01))
    expect(kindOf(snack.update(input({ subjects: team6 })), 'a')).toBe('snacks')
    const talk = new Life(dice(0, 0, 0, 0, 0, 0, PACE.mix.chat - 0.01, 0.9))
    expect(kindOf(talk.update(input({ subjects: team6 })), 'a')).toBe('chat')
  })

  it('goes to the other counter when the one they fancied is full', () => {
    const wantsTea = () => new Life(dice(0, 0))
    expect(
      kindOf(
        wantsTea().update(input({ open: { ...NO_ROOM, snacks: 1 }, subjects: [idle('a')] })),
        'a',
      ),
    ).toBe('snacks')
    const wantsSnack = () => new Life(dice(0, 0.5))
    expect(
      kindOf(
        wantsSnack().update(input({ open: { ...NO_ROOM, tea: 1 }, subjects: [idle('a')] })),
        'a',
      ),
    ).toBe('tea')
  })

  it('stays at their desk when both counters are full, and tries again later without waiting anew', () => {
    const life = new Life(dice(0, 0))
    expect(life.update(input({ open: NO_ROOM, subjects: [idle('a')] })).size).toBe(0)
    expect(life.update(input({ now: ready + 1_000, subjects: [idle('a')] })).size).toBe(1)
  })

  it('does not give two people the last spot at a counter', () => {
    // Six people, so two may be away, and both fancy tea, but there is one place at the tea counter.
    const life = new Life(dice(0))
    const team = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => idle(id))
    const on = life.update(input({ open: { ...NO_ROOM, tea: 1 }, subjects: team }))
    expect([...on.values()].map((o) => o.kind)).toEqual(['tea'])
  })

  it('gives the second person the other counter when the first took the last place at theirs', () => {
    const life = new Life(dice(0))
    const team = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => idle(id))
    const on = life.update(input({ open: { ...NO_ROOM, tea: 1, snacks: 1 }, subjects: team }))
    expect([...on.values()].map((o) => o.kind).sort()).toEqual(['snacks', 'tea'])
  })

  it('only ever names a counter that exists', () => {
    const life = new Life(dice(0, 0.3, 0.8))
    const on = life.update(
      input({ subjects: [idle('a'), idle('b'), idle('c'), idle('d'), idle('e'), idle('f')] }),
    )
    for (const outing of on.values()) expect(LIFE_KINDS).toContain(outing.kind)
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
      input({ now: ready + 7_000 + PACE.stayMs.tea[1], subjects, arrived: there }),
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
      life.update(input({ now: arrivedAt + PACE.stayMs.tea[0] - 1, subjects, arrived: there }))
        .size,
    ).toBe(1)
    expect(
      life.update(input({ now: arrivedAt + PACE.stayMs.tea[0], subjects, arrived: there })).size,
    ).toBe(0)
  })

  it('stays as long as the roll says, up to the longest', () => {
    const life = new Life(dice(0, 0, 0.999))
    const subjects = [idle('a')]
    startBreak(life, subjects)
    const there = new Set(['a'])
    life.update(input({ now: ready, subjects, arrived: there }))
    expect(
      life.update(input({ now: ready + PACE.stayMs.tea[0] + 1, subjects, arrived: there })).size,
    ).toBe(1)
    expect(
      life.update(input({ now: ready + PACE.stayMs.tea[1], subjects, arrived: there })).size,
    ).toBe(0)
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
    const over = ready + 1_000 + PACE.stayMs.tea[0]
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

describe('chats and meetings', () => {
  const zeros = (n: number) => Array.from({ length: n }, () => 0)
  const team = (n: number, patch: Partial<LifeSubject> = {}) =>
    Array.from({ length: n }, (_, i) => ({ ...idle(`e${i}`), ...patch }))
  /**
   * A die for a team of `n` all due at once: each one's wait (none), then what the first fancies, then
   * whatever else the rules roll (the size of a chat, who goes along), then zeros.
   */
  const roll = (n: number, ...after: number[]) => dice(...zeros(n), ...after, 0, 0, 0, 0, 0, 0)
  const groupOf = (on: Map<string, { members: readonly string[] }>, id: string) =>
    on.get(id)?.members

  describe('a chat', () => {
    const CHAT = 0.7

    it('takes two people to the pantry table together, each knowing who is with them', () => {
      const life = new Life(roll(2, CHAT, 0.9))
      const on = life.update(input({ subjects: team(2) }))
      expect(on.get('e0')).toMatchObject({ kind: 'chat', together: false })
      expect(on.get('e1')).toMatchObject({ kind: 'chat', together: false })
      expect(groupOf(on, 'e0')).toEqual(['e0', 'e1'])
      expect(groupOf(on, 'e1')).toEqual(['e0', 'e1'])
    })

    it('is three people below the chance of three and two at it', () => {
      const three = new Life(roll(6, CHAT, PACE.chatOfThree - 0.01))
      expect(groupOf(three.update(input({ subjects: team(6) })), 'e0')).toHaveLength(3)
      const two = new Life(roll(6, CHAT, PACE.chatOfThree))
      expect(groupOf(two.update(input({ subjects: team(6) })), 'e0')).toHaveLength(2)
    })

    it('keeps the partner in the chat, who is also due, from going off on their own', () => {
      // Twelve people, so plenty of room for others to go too; the partner must still be in the chat.
      const life = new Life(roll(12, CHAT, 0.9))
      const on = life.update(input({ subjects: team(12) }))
      const members = groupOf(on, 'e0') as readonly string[]
      expect(members).toHaveLength(2)
      for (const id of members) {
        expect(on.get(id), id).toMatchObject({ kind: 'chat', members })
      }
    })

    it('is what someone who fancied tea does when both counters are full', () => {
      // e0's moment has come and they fancy tea; e1 is ready but their own moment has not come, so
      // e1 goes only if e0 asks them along.
      const life = new Life(dice(0, 0.9, 0, 0.9, 0, 0))
      const on = life.update(input({ open: { ...ROOMY, tea: 0, snacks: 0 }, subjects: team(2) }))
      expect(kindOf(on, 'e0')).toBe('chat')
      expect(kindOf(on, 'e1')).toBe('chat')
    })

    it('is three people on a low roll, if the team is big enough to spare them', () => {
      const life = new Life(roll(6, CHAT, 0.1))
      const on = life.update(input({ subjects: team(6) }))
      expect(groupOf(on, 'e0')).toHaveLength(3)
      // Three of six is half the team: the most that ever goes together.
      expect(on.size).toBe(3)
    })

    it('is only ever two in a small team, however the roll falls', () => {
      for (const n of [2, 3, 4]) {
        const life = new Life(roll(n, CHAT, 0.1))
        const on = life.update(input({ subjects: team(n) }))
        expect(on.size, `${n}`).toBe(2)
      }
    })

    it('needs somebody else who is ready, and otherwise goes for tea or a snack', () => {
      // The other is not idle for long enough yet.
      const soon = [idle('a'), idle('b', ready - 1_000)]
      const alone = new Life(roll(1, CHAT))
      const on = alone.update(input({ subjects: soon }))
      expect(on.get('a')).toMatchObject({ kind: 'tea', members: ['a'] })
      expect(on.has('b')).toBe(false)
    })

    it('needs them to be free: someone whose agent is working is not asked along', () => {
      for (const state of ['coding', 'thinking', 'testing', 'error', 'offline'] as const) {
        const life = new Life(roll(1, CHAT))
        const on = life.update(input({ subjects: [idle('a'), idle('b', T0, state)] }))
        expect(kindOf(on, 'a'), state).toBe('tea')
        expect(on.has('b'), state).toBe(false)
      }
    })

    it('does not ask along someone who has somewhere real to be', () => {
      const busy: LifeSubject = { ...idle('b'), busy: true }
      const on = new Life(roll(1, CHAT)).update(input({ subjects: [idle('a'), busy] }))
      expect(kindOf(on, 'a')).toBe('tea')
      expect(on.has('b')).toBe(false)
    })

    it('does not ask along someone who has only just been out', () => {
      // b goes for tea alone, is back after the shortest stay, and a comes along a moment later.
      const life = new Life(dice(0, 0, 0, 0, CHAT))
      life.update(input({ subjects: [idle('b')] }))
      const there = new Set(['b'])
      life.update(input({ now: ready + 1_000, subjects: [idle('b')], arrived: there }))
      const over = ready + 1_000 + PACE.stayMs.tea[0]
      expect(life.update(input({ now: over, subjects: [idle('b')], arrived: there })).size).toBe(0)
      const on = life.update(input({ now: over + 1_000, subjects: [idle('a'), idle('b')] }))
      // a wants a chat but b is not ready, so a has tea.
      expect(on.get('a')).toMatchObject({ kind: 'tea', members: ['a'] })
      expect(on.has('b')).toBe(false)
    })

    it('needs room at the table for them all, and otherwise goes for tea', () => {
      const life = new Life(roll(2, CHAT, 0.9))
      const on = life.update(input({ open: { ...ROOMY, chat: 1 }, subjects: team(2) }))
      expect(kindOf(on, 'e0')).toBe('tea')
      expect(on.size).toBe(1)
    })

    it('makes way for others: a chat is more than a third of a small team only when nobody else is out', () => {
      // Three people, so one may be away; a chat of two is let through because nobody else is out.
      const life = new Life(roll(3, CHAT, 0.9))
      const on = life.update(input({ subjects: team(3) }))
      expect(on.size).toBe(2)
      // The third is due too, but two are already away and that is all that may be.
      expect(on.has('e2')).toBe(false)
    })

    it('does not go over the limit when somebody else is already out: they have tea instead', () => {
      // Six people, so two may be away. e0 goes for tea; e1 fancies a chat, but a chat of two
      // would make three, so e1 has tea as well.
      const life = new Life(roll(6, 0, CHAT, 0.9))
      const on = life.update(input({ subjects: team(6) }))
      expect([...on.values()].map((o) => o.kind)).toEqual(['tea', 'tea'])
    })
  })

  describe('a meeting', () => {
    const MEETING = 0.95

    it('takes three people to the meeting room together, in a team of six or more', () => {
      const life = new Life(roll(6, MEETING, 0, 0, 0))
      const on = life.update(input({ subjects: team(6) }))
      expect(on.get('e0')).toMatchObject({ kind: 'meeting', together: false })
      expect(groupOf(on, 'e0')).toHaveLength(3)
      expect(on.size).toBe(3)
    })

    it('is up to five in a team of ten or more, and never more than half the team', () => {
      const life = new Life(roll(12, MEETING, 0.99, 0, 0, 0, 0))
      const on = life.update(input({ subjects: team(12) }))
      expect(groupOf(on, 'e0')).toHaveLength(5)
      const small = new Life(roll(8, MEETING, 0.99, 0, 0, 0, 0))
      expect(groupOf(small.update(input({ subjects: team(8) })), 'e0')).toHaveLength(4)
    })

    it('needs a team of six, so it never takes more than half of them; a smaller one has a chat instead', () => {
      const life = new Life(roll(5, MEETING, 0.9))
      const on = life.update(input({ subjects: team(5) }))
      expect(on.get('e0')).toMatchObject({ kind: 'chat' })
    })

    it('needs enough others who are ready, and otherwise has a chat', () => {
      // Six people, but only one other is free.
      const subjects = [
        idle('a'),
        idle('b'),
        ...team(4, { state: 'coding' }).map((p, i) => ({ ...p, id: `w${i}` })),
      ]
      const life = new Life(roll(2, MEETING, 0.9))
      const on = life.update(input({ subjects }))
      expect(on.get('a')).toMatchObject({ kind: 'chat' })
    })

    it('needs room in the meeting room for them all', () => {
      const life = new Life(roll(6, MEETING, 0, 0))
      const on = life.update(input({ open: { ...ROOMY, meeting: 2 }, subjects: team(6) }))
      expect(on.get('e0')?.kind).not.toBe('meeting')
    })
  })

  describe('together', () => {
    const CHAT = 0.7
    const start = () => {
      // Waits, fancy a chat, a pair, the first partner, then the shortest stay.
      const life = new Life(dice(0, 0, CHAT, 0.9, 0, 0))
      life.update(input({ subjects: team(2) }))
      return life
    }

    it('begins only when they are all there', () => {
      const life = start()
      const one = life.update(
        input({ now: ready + 5_000, subjects: team(2), arrived: new Set(['e0']) }),
      )
      expect(one.get('e0')?.together).toBe(false)
      const both = life.update(
        input({ now: ready + 6_000, subjects: team(2), arrived: new Set(['e0', 'e1']) }),
      )
      expect(both.get('e0')?.together).toBe(true)
      expect(both.get('e1')?.together).toBe(true)
    })

    it('does not start the stay for the first to arrive, only once all are there', () => {
      const life = start()
      const there = new Set(['e0'])
      // e0 waits at the table for a long time; e1 arrives late but in time.
      life.update(input({ now: ready + 30_000, subjects: team(2), arrived: there }))
      const late = ready + 40_000
      const both = new Set(['e0', 'e1'])
      expect(life.update(input({ now: late, subjects: team(2), arrived: both })).size).toBe(2)
      const stay = PACE.stayMs.chat[0]
      expect(
        life.update(input({ now: late + stay - 1, subjects: team(2), arrived: both })).size,
      ).toBe(2)
      expect(life.update(input({ now: late + stay, subjects: team(2), arrived: both })).size).toBe(
        0,
      )
    })

    it('ends for everyone at once, and each has to wait before going again', () => {
      const life = start()
      const both = new Set(['e0', 'e1'])
      life.update(input({ now: ready + 1_000, subjects: team(2), arrived: both }))
      const over = ready + 1_000 + PACE.stayMs.chat[0]
      expect(life.update(input({ now: over, subjects: team(2), arrived: both })).size).toBe(0)
      expect(life.update(input({ now: over + 1_000, subjects: team(2) })).size).toBe(0)
    })

    it('stays longer for a chat than for a cup of tea, and longer still for a meeting', () => {
      expect(PACE.stayMs.chat[0]).toBeGreaterThan(PACE.stayMs.tea[0])
      expect(PACE.stayMs.meeting[0]).toBeGreaterThan(PACE.stayMs.chat[0])
      expect(PACE.stayMs.meeting[1]).toBeGreaterThan(PACE.stayMs.chat[1])
    })

    it('is given up if they do not all get there in time, for everyone', () => {
      const life = start()
      const only = new Set(['e0'])
      expect(
        life.update(input({ now: ready + PACE.travelMs - 1, subjects: team(2), arrived: only }))
          .size,
      ).toBe(2)
      expect(
        life.update(input({ now: ready + PACE.travelMs, subjects: team(2), arrived: only })).size,
      ).toBe(0)
    })

    it('is over for both when one of two goes back to work', () => {
      const life = start()
      const both = new Set(['e0', 'e1'])
      life.update(input({ now: ready + 1_000, subjects: team(2), arrived: both }))
      const busy = [idle('e0'), idle('e1', ready + 2_000, 'coding')]
      expect(life.update(input({ now: ready + 2_000, subjects: busy, arrived: both })).size).toBe(0)
    })

    it('goes on with those who are left when one of three goes back to work', () => {
      const life = new Life(roll(6, CHAT, 0.1))
      life.update(input({ subjects: team(6) }))
      const three = new Set(['e0', 'e1', 'e2'])
      const subjects = team(6)
      const leaves = [
        subjects[0],
        { ...(subjects[1] as LifeSubject), state: 'coding' as const },
        ...subjects.slice(2),
      ] as LifeSubject[]
      const on = life.update(input({ now: ready + 1_000, subjects: leaves, arrived: three }))
      const members = [...on.keys()].sort()
      expect(members).toHaveLength(2)
      expect(on.get(members[0] as string)?.members).toHaveLength(2)
    })

    it('calls everyone back at once when it is switched off', () => {
      const life = start()
      expect(
        life.update(input({ now: ready + 1_000, subjects: team(2), enabled: false })).size,
      ).toBe(0)
    })
  })
})

describe('speaker', () => {
  const members = ['a', 'b', 'c']

  it('gives each their turn in order, and starts over', () => {
    expect(speaker(members, 0)).toBe('a')
    expect(speaker(members, TURN_MS - 1)).toBe('a')
    expect(speaker(members, TURN_MS)).toBe('b')
    expect(speaker(members, 2 * TURN_MS)).toBe('c')
    expect(speaker(members, 3 * TURN_MS)).toBe('a')
  })

  it('is always the one person when there is only one', () => {
    for (const now of [0, TURN_MS, 5 * TURN_MS + 3]) expect(speaker(['a'], now)).toBe('a')
  })

  it('is nobody when nobody is there', () => {
    expect(speaker([], 12345)).toBeUndefined()
  })

  it('is a few seconds a turn', () => {
    expect(TURN_MS).toBeGreaterThan(1_000)
    expect(TURN_MS).toBeLessThan(6_000)
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

  /** Six people idle all day; whoever is out reaches their place eight seconds after setting off. */
  function day(seed: number, minutes: number, team = 6) {
    const life = new Life(seeded(seed))
    const ids = Array.from({ length: team }, (_, i) => `e${i}`)
    const subjects = ids.map((id) => idle(id))
    const started = new Map<string, number[]>()
    const kinds = new Map<LifeKind, number>()
    const away = new Map<string, number>()
    let most = 0
    /** Moments when more than a third were out and it was not one outing on its own. */
    let overCap = 0
    const cap = Math.max(1, Math.floor(team / 3))
    for (let ms = 0; ms <= minutes * 60_000; ms += 1_000) {
      const now = T0 + ms
      const there = new Set([...away].filter(([, since]) => now - since >= 8_000).map(([id]) => id))
      const on = life.update(input({ now, subjects, arrived: there }))
      for (const id of away.keys()) if (!on.has(id)) away.delete(id)
      for (const [id, outing] of on) {
        if (!away.has(id)) {
          away.set(id, now)
          started.set(id, [...(started.get(id) ?? []), now])
          kinds.set(outing.kind, (kinds.get(outing.kind) ?? 0) + 1)
        }
      }
      const groups = new Set([...on.values()].map((o) => o.members.join()))
      if (on.size > cap && groups.size > 1) overCap += 1
      most = Math.max(most, on.size)
    }
    return { started, most, overCap, kinds }
  }

  it('never has more than a third of the team away at once, except one chat or meeting on its own', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      expect(day(seed, 30).overCap, `${seed}`).toBe(0)
    }
  })

  it('never takes more than half the team to one chat or meeting', () => {
    for (const team of [2, 3, 4, 6, 9, 12]) {
      for (const seed of [1, 2, 3]) {
        expect(day(seed, 20, team).most, `${team} people, seed ${seed}`).toBeLessThanOrEqual(
          Math.max(2, Math.floor(team / 2), Math.floor(team / 3)),
        )
      }
    }
  })

  it('has every kind of outing in a day, and chats more often than meetings', () => {
    const total = new Map<LifeKind, number>()
    for (const seed of [1, 2, 3, 4]) {
      for (const [kind, n] of day(seed, 60, 12).kinds) total.set(kind, (total.get(kind) ?? 0) + n)
    }
    for (const kind of LIFE_KINDS) expect(total.get(kind), kind).toBeGreaterThan(0)
    expect(total.get('chat') ?? 0).toBeGreaterThan(total.get('meeting') ?? 0)
    expect(total.get('tea') ?? 0).toBeGreaterThan(total.get('chat') ?? 0)
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
