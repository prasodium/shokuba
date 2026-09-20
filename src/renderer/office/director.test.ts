import { describe, expect, it } from 'vitest'
import type { RuntimeState } from '@shared/types/agent'
import { Director, RULES, type Rule, type Subject } from './director'
import { buildOffice, type Place } from './map'

const places: Place[] = buildOffice().places
const T0 = 1_000_000
const testing = (id: string, since = T0): Subject => ({ id, state: 'testing', since })
const doing = (id: string, state: RuntimeState, since = T0): Subject => ({ id, state, since })
const targetOf = (d: Map<string, { target: unknown }>, id: string) => d.get(id)?.target

describe('the rules', () => {
  it('start with one: running tests takes someone to the QA bench, after a few seconds, and back after a moment', () => {
    expect(RULES).toEqual([{ state: 'testing', place: 'qa', enterMs: 3_000, leaveMs: 2_500 }])
  })
})

describe('setting off', () => {
  it('waits until the state has lasted long enough, and then goes', () => {
    const director = new Director(places)
    for (const ms of [0, 1_000, 2_999]) {
      expect(targetOf(director.update(T0 + ms, [testing('ada')]), 'ada')).toBeNull()
    }
    expect(targetOf(director.update(T0 + 3_000, [testing('ada')]), 'ada')).toEqual({
      placeId: 'qa',
      kind: 'qa',
      slot: 0,
    })
  })

  it('never sends anyone for a state that is not a reason to go', () => {
    const director = new Director(places)
    const states: RuntimeState[] = [
      'idle',
      'thinking',
      'coding',
      'researching',
      'reviewing',
      'waiting',
      'blocked',
      'error',
      'starting',
    ]
    for (const state of states) {
      expect(targetOf(director.update(T0 + 60_000, [doing('ada', state)]), 'ada'), state).toBeNull()
    }
  })

  it('never goes for a flicker: a state that keeps coming and going never lasts long enough', () => {
    const director = new Director(places)
    let now = T0
    for (let i = 0; i < 20; i += 1) {
      // Testing for two seconds, then something else for two, again and again.
      expect(targetOf(director.update(now + 2_000, [testing('ada', now)]), 'ada')).toBeNull()
      now += 2_000
      director.update(now + 1_000, [doing('ada', 'coding', now)])
      now += 2_000
    }
  })

  it('needs somewhere to go: with no bench, nobody goes', () => {
    const director = new Director(places.filter((p) => p.kind !== 'qa'))
    expect(targetOf(director.update(T0 + 60_000, [testing('ada')]), 'ada')).toBeNull()
  })
})

describe('coming back', () => {
  const goes = (director: Director, id = 'ada'): void => {
    director.update(T0 + 3_000, [testing(id)])
  }

  it('lingers for a moment once the state is over, then goes home', () => {
    const director = new Director(places)
    goes(director)
    const over = T0 + 10_000
    expect(
      targetOf(director.update(over + 2_499, [doing('ada', 'coding', over)]), 'ada'),
    ).not.toBeNull()
    expect(
      targetOf(director.update(over + 2_500, [doing('ada', 'coding', over)]), 'ada'),
    ).toBeNull()
  })

  it('stays if the state comes back before that, and so never goes to and fro', () => {
    const director = new Director(places)
    goes(director)
    const over = T0 + 10_000
    director.update(over + 1_000, [doing('ada', 'coding', over)])
    // Testing again a second later: still at the bench, and never sent home in between.
    const again = over + 1_000
    expect(targetOf(director.update(again + 500, [testing('ada', again)]), 'ada')).not.toBeNull()
    expect(targetOf(director.update(again + 60_000, [testing('ada', again)]), 'ada')).not.toBeNull()
  })

  it('goes home at once if the agent is switched off, and says nobody is there', () => {
    const director = new Director(places)
    goes(director)
    for (const state of ['offline', 'stopped', 'paused'] as const) {
      const d = new Director(places)
      d.update(T0 + 3_000, [testing('ada')])
      const decision = d.update(T0 + 3_100, [doing('ada', state, T0 + 3_100)]).get('ada')
      expect(decision, state).toMatchObject({ target: null, absent: true })
    }
  })
})

describe('the spots at a place', () => {
  const bench = places.find((p) => p.kind === 'qa') as Place

  it('gives each person their own, in order', () => {
    const director = new Director(places)
    const crowd = ['a', 'b', 'c'].map((id) => testing(id))
    const decisions = director.update(T0 + 3_000, crowd)
    expect(['a', 'b', 'c'].map((id) => (targetOf(decisions, id) as { slot: number }).slot)).toEqual(
      [0, 1, 2],
    )
    expect(bench.slots).toHaveLength(3)
  })

  it('keeps anyone who does not fit at their desk, and gives them a spot when one is free', () => {
    const director = new Director(places)
    const crowd = ['a', 'b', 'c', 'd'].map((id, i) => testing(id, T0 + i))
    let decisions = director.update(T0 + 10_000, crowd)
    expect(targetOf(decisions, 'd')).toBeNull()
    expect(['a', 'b', 'c'].every((id) => targetOf(decisions, id) !== null)).toBe(true)

    // b finishes and goes home: d takes b's place.
    const bDone = T0 + 20_000
    const next = [crowd[0], doing('b', 'coding', bDone), crowd[2], crowd[3]] as Subject[]
    decisions = director.update(bDone + 3_000, next)
    expect(targetOf(decisions, 'b')).toBeNull()
    expect(targetOf(decisions, 'd')).toEqual({ placeId: 'qa', kind: 'qa', slot: 1 })
  })

  it('gives a free spot to whoever has been waiting longest, whatever the roster order', () => {
    const director = new Director(places)
    const full = ['a', 'b', 'c'].map((id) => testing(id, T0))
    director.update(T0 + 3_000, full)
    const waiters = [testing('late', T0 + 5_000), testing('early', T0 + 4_000)]
    director.update(T0 + 9_000, [...full, ...waiters])
    // A spot frees up: the one who has waited longer gets it.
    const done = T0 + 20_000
    const decisions = director.update(done + 3_000, [
      doing('a', 'coding', done),
      full[1],
      full[2],
      ...waiters,
    ] as Subject[])
    expect(targetOf(decisions, 'early')).not.toBeNull()
    expect(targetOf(decisions, 'late')).toBeNull()
  })

  it('takes nobody’s spot: two people never share one', () => {
    const director = new Director(places)
    const crowd = Array.from({ length: 6 }, (_, i) => testing(`e${i}`, T0 + i))
    const decisions = director.update(T0 + 30_000, crowd)
    const spots = [...decisions.values()].flatMap((d) =>
      d.target ? [`${d.target.placeId}:${d.target.slot}`] : [],
    )
    expect(new Set(spots).size).toBe(spots.length)
    expect(spots).toHaveLength(3)
  })

  it('frees the spot of someone who is no longer in the office', () => {
    const director = new Director(places)
    director.update(
      T0 + 3_000,
      ['a', 'b', 'c'].map((id) => testing(id)),
    )
    const decisions = director.update(T0 + 4_000, [testing('b'), testing('c'), testing('d', T0)])
    expect(targetOf(decisions, 'd')).toEqual({ placeId: 'qa', kind: 'qa', slot: 0 })
  })
})

describe('reduced motion', () => {
  it('means nobody goes anywhere, and anyone already away comes home', () => {
    const director = new Director(places)
    director.update(T0 + 3_000, [testing('ada')])
    const still = director.update(T0 + 4_000, [testing('ada')], { reducedMotion: true })
    expect(targetOf(still, 'ada')).toBeNull()
    expect(
      targetOf(director.update(T0 + 60_000, [testing('ada')], { reducedMotion: true }), 'ada'),
    ).toBeNull()
  })

  it('lets them go again when it is turned off', () => {
    const director = new Director(places)
    director.update(T0 + 60_000, [testing('ada')], { reducedMotion: true })
    expect(targetOf(director.update(T0 + 60_001, [testing('ada')]), 'ada')).not.toBeNull()
  })
})

describe('the first time someone is seen', () => {
  it('is marked, so they appear where they belong instead of walking there', () => {
    const director = new Director(places)
    const decisions = director.update(T0 + 60_000, [testing('ada'), doing('sora', 'idle')])
    expect(decisions.get('ada')).toMatchObject({ first: true, target: { placeId: 'qa' } })
    expect(decisions.get('sora')).toMatchObject({ first: true, target: null })
    const later = director.update(T0 + 61_000, [testing('ada'), doing('sora', 'idle')])
    expect(later.get('ada')?.first).toBe(false)
  })

  it('is marked again for someone who left and came back', () => {
    const director = new Director(places)
    director.update(T0, [doing('ada', 'idle')])
    director.update(T0 + 1, [])
    expect(director.update(T0 + 2, [doing('ada', 'idle')]).get('ada')?.first).toBe(true)
  })
})

describe('when the plan changes', () => {
  it('keeps people where they are if their place is still there, and sends them home if not', () => {
    const director = new Director(places)
    director.update(T0 + 3_000, [testing('ada')])
    director.setPlaces(buildOffice().places)
    expect(targetOf(director.update(T0 + 4_000, [testing('ada')]), 'ada')).not.toBeNull()
    director.setPlaces(places.filter((p) => p.kind !== 'qa'))
    expect(targetOf(director.update(T0 + 5_000, [testing('ada')]), 'ada')).toBeNull()
  })

  it('does not keep a spot the place no longer has', () => {
    const director = new Director(places)
    director.update(
      T0 + 3_000,
      ['a', 'b', 'c'].map((id) => testing(id)),
    )
    const smaller = places.map((p) => (p.kind === 'qa' ? { ...p, slots: p.slots.slice(0, 1) } : p))
    director.setPlaces(smaller)
    const decisions = director.update(
      T0 + 4_000,
      ['a', 'b', 'c'].map((id) => testing(id)),
    )
    expect(targetOf(decisions, 'a')).not.toBeNull()
    expect(targetOf(decisions, 'b')).toBeNull()
    expect(targetOf(decisions, 'c')).toBeNull()
  })
})

describe('a rule of your own', () => {
  it('works for any state and place, so later slices only add to the table', () => {
    const rule: Rule = { state: 'reviewing', place: 'reading', enterMs: 0, leaveMs: 0 }
    const director = new Director(places, [rule])
    expect(targetOf(director.update(T0, [doing('ada', 'reviewing')]), 'ada')).toEqual({
      placeId: 'reading-1',
      kind: 'reading',
      slot: 0,
    })
  })
})

describe('errands', () => {
  const reviewing = (id: string, since = T0): Subject => ({
    id,
    state: 'thinking',
    since,
    errand: 'reading',
  })
  const desk = (id: string, state: RuntimeState = 'thinking', since = T0): Subject => ({
    id,
    state,
    since,
  })

  it('send someone to that kind of place at once, whatever their state and however long it has lasted', () => {
    const director = new Director(places)
    // Their state only just began: a state rule would still make them wait.
    expect(targetOf(director.update(T0, [reviewing('cy', T0)]), 'cy')).toEqual({
      placeId: 'reading-1',
      kind: 'reading',
      slot: 0,
    })
  })

  it('bring them home the moment the errand is over', () => {
    const director = new Director(places)
    director.update(T0, [reviewing('cy')])
    expect(targetOf(director.update(T0 + 1, [desk('cy')]), 'cy')).toBeNull()
  })

  it('keep them there for as long as it lasts', () => {
    const director = new Director(places)
    director.update(T0, [reviewing('cy')])
    expect(targetOf(director.update(T0 + 600_000, [reviewing('cy')]), 'cy')).not.toBeNull()
  })

  it('give two reviewers the two reading desks, and a third has to wait', () => {
    const director = new Director(places)
    const d = director.update(T0, [reviewing('a'), reviewing('b'), reviewing('c')])
    expect(targetOf(d, 'a')).toMatchObject({ placeId: 'reading-1' })
    expect(targetOf(d, 'b')).toMatchObject({ placeId: 'reading-2' })
    expect(targetOf(d, 'c')).toBeNull()
    // The desk of the first to finish goes to the one waiting.
    const later = director.update(T0 + 100, [desk('a'), reviewing('b'), reviewing('c')])
    expect(targetOf(later, 'c')).toMatchObject({ placeId: 'reading-1' })
  })

  it('come before a state rule: someone at the bench goes to review instead', () => {
    const director = new Director(places)
    director.update(T0 + 3_000, [testing('cy')])
    expect(targetOf(director.update(T0 + 3_100, [testing('cy')]), 'cy')).toMatchObject({
      kind: 'qa',
    })
    const both: Subject = { id: 'cy', state: 'testing', since: T0, errand: 'reading' }
    director.update(T0 + 3_200, [both])
    expect(targetOf(director.update(T0 + 3_300, [both]), 'cy')).toMatchObject({ kind: 'reading' })
  })

  it('then let a state rule take over when the errand ends', () => {
    const director = new Director(places)
    director.update(T0 + 5_000, [{ id: 'cy', state: 'testing', since: T0, errand: 'reading' }])
    director.update(T0 + 5_100, [testing('cy')])
    expect(targetOf(director.update(T0 + 5_200, [testing('cy')]), 'cy')).toMatchObject({
      kind: 'qa',
    })
  })

  it('are given up when the agent is switched off, and never used with reduced motion', () => {
    for (const state of ['offline', 'stopped', 'paused'] as const) {
      const director = new Director(places)
      const off: Subject = { id: 'cy', state, since: T0, errand: 'reading' }
      expect(director.update(T0, [off]).get('cy')).toMatchObject({ target: null, absent: true })
    }
    const still = new Director(places)
    expect(targetOf(still.update(T0, [reviewing('cy')], { reducedMotion: true }), 'cy')).toBeNull()
  })

  it('need a place to go to: with no reading room, nobody goes', () => {
    const director = new Director(places.filter((p) => p.kind !== 'reading'))
    expect(targetOf(director.update(T0, [reviewing('cy')]), 'cy')).toBeNull()
  })

  it('do not change how a state rule waits for anyone else', () => {
    const director = new Director(places)
    const d = director.update(T0 + 2_000, [reviewing('cy'), testing('ada')])
    expect(targetOf(d, 'cy')).not.toBeNull()
    expect(targetOf(d, 'ada')).toBeNull()
  })
})
