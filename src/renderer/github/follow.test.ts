import { describe, expect, it } from 'vitest'
import type { PullStatus } from '@shared/github'
import { REFRESH_MS, checkedLine, checksLine, followUpNote, isWatching, stateLine } from './follow'

const checks = (
  states: Array<'passed' | 'failed' | 'pending'>,
  overall: PullStatus['checks']['overall'],
): PullStatus['checks'] => ({
  overall,
  items: states.map((state, i) => ({ ref: `run:${i}`, name: `c${i}`, state, url: null })),
})

describe('isWatching', () => {
  it('watches until it has looked once, and while the pull request is open', () => {
    expect(isWatching(null)).toBe(true)
    expect(isWatching({ state: 'open' })).toBe(true)
  })

  it('stops when the pull request is over, since it will not change', () => {
    expect(isWatching({ state: 'merged' })).toBe(false)
    expect(isWatching({ state: 'closed' })).toBe(false)
  })

  it('looks about once a minute', () => {
    expect(REFRESH_MS).toBe(60_000)
  })
})

describe('stateLine', () => {
  it('says merged, closed, open, and whether it is a draft', () => {
    expect(stateLine({ state: 'merged', draft: false })).toBe('Merged')
    expect(stateLine({ state: 'closed', draft: true })).toBe('Closed without being merged')
    expect(stateLine({ state: 'open', draft: true })).toBe('Open, as a draft')
    expect(stateLine({ state: 'open', draft: false })).toBe('Open')
  })
})

describe('checksLine', () => {
  it('says there are none, all pass, some are running, or some fail, with counts', () => {
    expect(checksLine(checks([], 'none'))).toBe('No checks reported yet')
    expect(checksLine(checks(['passed'], 'passing'))).toBe('1 check passing')
    expect(checksLine(checks(['passed', 'passed'], 'passing'))).toBe('2 checks passing')
    expect(checksLine(checks(['passed', 'pending'], 'pending'))).toBe(
      '1 check still running, 1 passing',
    )
    expect(checksLine(checks(['failed', 'passed', 'passed'], 'failing'))).toBe(
      '1 check failing, 2 passing',
    )
    expect(checksLine(checks(['failed', 'failed', 'pending'], 'failing'))).toBe(
      '2 checks failing, 0 passing, 1 still running',
    )
  })
})

describe('followUpNote', () => {
  it('says that nothing runs by itself, and what to do next', () => {
    expect(followUpNote({ reopened: true })).toMatch(/reopened and is paused.*press Resume/)
    expect(followUpNote({ reopened: false })).toMatch(/Give it to someone/)
  })
})

describe('checkedLine', () => {
  it('gives a time of day, and nothing for one it cannot read', () => {
    expect(checkedLine('2026-09-20T12:34:00.000Z')).toMatch(/^Looked at GitHub at \d/)
    expect(checkedLine('')).toBe('')
    expect(checkedLine('yesterday')).toBe('')
  })
})
