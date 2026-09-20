import { describe, expect, it } from 'vitest'
import { canOpen, openLabel, recordLine, resultLine, willDo } from './pull'

const preview = {
  branch: 'shokuba/mission/m1',
  repo: 'acme/widgets',
  login: 'octocat',
  base: 'main',
  existing: null,
}

describe('canOpen', () => {
  it('is true only when nothing is in the way', () => {
    expect(canOpen({ problems: [] })).toBe(true)
    expect(canOpen({ problems: ['Nothing has been accepted yet.'] })).toBe(false)
    expect(canOpen({ problems: ['a', 'b'] })).toBe(false)
  })
})

describe('openLabel', () => {
  it('says it opens a pull request, or that it only adds to one that is already open', () => {
    expect(openLabel({ existing: null })).toBe('Push the branch and open the pull request')
    expect(openLabel({ existing: { number: 3, url: 'u', draft: false } })).toBe(
      'Push the new commits to #3',
    )
  })
})

describe('willDo', () => {
  it('says what will be pushed, where, and as whom, before anything happens', () => {
    const text = willDo(preview, true)
    expect(text).toContain('pushes shokuba/mission/m1 to GitHub using your own Git setup')
    expect(text).toContain('opens a draft pull request in acme/widgets, into main, as octocat')
  })

  it('says whether it is a draft', () => {
    expect(willDo(preview, true)).toContain('a draft pull request')
    expect(willDo(preview, false)).toContain('opens a pull request')
    expect(willDo(preview, false)).not.toContain('draft')
  })

  it('says it only adds commits when a pull request is already open, and opens nothing', () => {
    const text = willDo({ ...preview, existing: { number: 3, url: 'u', draft: false } }, true)
    expect(text).toContain('adds the new commits to pull request #3')
    expect(text).not.toContain('opens')
  })

  it('always says what it will never do', () => {
    for (const draft of [true, false]) {
      expect(willDo(preview, draft)).toContain(
        'never merges anything, and never comments on the issue',
      )
    }
  })
})

describe('resultLine', () => {
  it('says what was done', () => {
    expect(resultLine({ number: 7, draft: true, existing: false })).toBe(
      'Opened draft pull request #7.',
    )
    expect(resultLine({ number: 7, draft: false, existing: false })).toBe('Opened pull request #7.')
    expect(resultLine({ number: 3, draft: false, existing: true })).toBe(
      'Pushed the new commits to pull request #3.',
    )
  })
})

describe('recordLine', () => {
  it('names the pull request and whether it is a draft', () => {
    expect(recordLine({ number: 7, draft: true }, 'acme/widgets')).toBe(
      'Pull request #7 in acme/widgets (draft)',
    )
    expect(recordLine({ number: 7, draft: false }, 'acme/widgets')).toBe(
      'Pull request #7 in acme/widgets',
    )
  })
})
