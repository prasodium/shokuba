import { describe, expect, it } from 'vitest'
import {
  IssueImportRequestSchema,
  IssuesRequestSchema,
  OWNER_PATTERN,
  REPO_PATTERN,
  isRepoRef,
} from './github'

describe('owner names', () => {
  it('are the ones GitHub allows', () => {
    for (const name of ['a', 'octo', 'octo-cat', 'Octo123', 'a1', 'x'.repeat(39)]) {
      expect(OWNER_PATTERN.test(name), name).toBe(true)
    }
  })

  it('are never empty, too long, hyphen-led, hyphen-ended or doubled, or anything else', () => {
    for (const name of [
      '',
      'x'.repeat(40),
      '-a',
      'a-',
      'a--b',
      'a_b',
      'a.b',
      'a b',
      'a/b',
      '../x',
      'a\n',
      'é',
    ]) {
      expect(OWNER_PATTERN.test(name), JSON.stringify(name)).toBe(false)
    }
  })
})

describe('repository names', () => {
  it('are the ones GitHub allows', () => {
    for (const name of [
      'r',
      'widgets',
      'my.repo',
      'my_repo',
      'my-repo',
      '.github',
      'a..b',
      'x'.repeat(100),
    ]) {
      expect(REPO_PATTERN.test(name), name).toBe(true)
    }
  })

  it('are never empty, too long, `.` or `..`, or anything that could change a request', () => {
    for (const name of [
      '',
      'x'.repeat(101),
      '.',
      '..',
      'a/b',
      'a?b',
      'a#b',
      'a b',
      'a%2Fb',
      'a\n',
      '../x',
      'é',
    ]) {
      expect(REPO_PATTERN.test(name), JSON.stringify(name)).toBe(false)
    }
  })
})

describe('isRepoRef', () => {
  it('needs both to be allowed', () => {
    expect(isRepoRef({ owner: 'octo', repo: 'widgets' })).toBe(true)
    expect(isRepoRef({ owner: 'octo/x', repo: 'widgets' })).toBe(false)
    expect(isRepoRef({ owner: 'octo', repo: '..' })).toBe(false)
    expect(isRepoRef({ owner: '', repo: 'widgets' })).toBe(false)
  })
})

describe('IssuesRequestSchema', () => {
  it('reads a project and which issues, showing the open ones unless said otherwise', () => {
    expect(IssuesRequestSchema.parse({ repoRoot: '/w' })).toEqual({ repoRoot: '/w', state: 'open' })
    for (const state of ['open', 'closed', 'all']) {
      expect(IssuesRequestSchema.parse({ repoRoot: '/w', state }).state).toBe(state)
    }
  })

  it('refuses anything else', () => {
    for (const bad of [
      {},
      { repoRoot: '' },
      { repoRoot: 5 },
      { repoRoot: '/w', state: 'merged' },
      { repoRoot: '/w', extra: 1 },
      { repoRoot: 'x'.repeat(1025) },
      null,
      'x',
    ]) {
      expect(IssuesRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('IssueImportRequestSchema', () => {
  it('reads a project and an issue number', () => {
    expect(IssueImportRequestSchema.parse({ repoRoot: '/w', number: 7 })).toEqual({
      repoRoot: '/w',
      number: 7,
    })
  })

  it('refuses a number that is not a whole, positive issue number, and anything extra', () => {
    for (const number of [0, -1, 1.5, '7', null, Number.NaN, 3_000_000_000]) {
      expect(
        IssueImportRequestSchema.safeParse({ repoRoot: '/w', number }).success,
        String(number),
      ).toBe(false)
    }
    expect(IssueImportRequestSchema.safeParse({ repoRoot: '/w', number: 7, x: 1 }).success).toBe(
      false,
    )
    expect(IssueImportRequestSchema.safeParse({ number: 7 }).success).toBe(false)
  })
})
