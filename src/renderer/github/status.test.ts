import { describe, expect, it } from 'vitest'
import type { GitHubLink, IssueSummary } from '@shared/github'
import { importedAs, issueMeta, statusLine, whenText } from './status'

describe('statusLine', () => {
  it('says it is checking until it knows', () => {
    expect(statusLine(null)).toMatchObject({ tone: 'warn', text: 'Checking GitHub…', hint: null })
  })

  it('says who is signed in, with nothing to do', () => {
    expect(statusLine({ state: 'ready', login: 'octocat' })).toEqual({
      tone: 'good',
      text: 'Signed in to GitHub as octocat',
      hint: null,
    })
  })

  it('says how to get gh when it is not there', () => {
    const line = statusLine({ state: 'missing' })
    expect(line.tone).toBe('bad')
    expect(line.hint).toContain('https://cli.github.com')
    expect(line.hint).toContain('gh auth login')
  })

  it('says how to sign in, and that Shokuba never sees the login', () => {
    const line = statusLine({ state: 'signed-out' })
    expect(line.tone).toBe('bad')
    expect(line.hint).toContain('gh auth login')
    expect(line.hint).toMatch(/never sees/)
  })

  it('shows the reason for any other problem', () => {
    expect(statusLine({ state: 'error', message: 'GitHub could not be reached.' })).toEqual({
      tone: 'bad',
      text: 'GitHub could not be reached.',
      hint: null,
    })
  })
})

const link = (repo: string, issueNumber: number): GitHubLink => ({
  missionId: `m-${repo}-${issueNumber}`,
  repo,
  repoRoot: '/r',
  issueNumber,
  issueTitle: 't',
  issueUrl: 'u',
  issueAuthor: null,
  issueBody: '',
  importedAt: 't',
})

describe('importedAs', () => {
  const links = [link('octo/widgets', 7), link('octo/gears', 7), link('octo/widgets', 9)]

  it('finds the mission an issue was made into', () => {
    expect(importedAs(links, 'octo/gears', 7)?.missionId).toBe('m-octo/gears-7')
  })

  it('tells the same number in another repository apart, and finds nothing for the rest', () => {
    expect(importedAs(links, 'octo/widgets', 7)?.missionId).toBe('m-octo/widgets-7')
    expect(importedAs(links, 'octo/widgets', 8)).toBeUndefined()
    expect(importedAs(links, 'other/widgets', 7)).toBeUndefined()
    expect(importedAs([], 'octo/widgets', 7)).toBeUndefined()
  })
})

describe('whenText', () => {
  const now = Date.UTC(2026, 5, 15, 12, 0, 0)
  const ago = (ms: number) => new Date(now - ms).toISOString()
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR

  it('is “just now” for under a minute, and for a time that has not come yet', () => {
    expect(whenText(ago(30_000), now)).toBe('just now')
    expect(whenText(ago(-5 * MIN), now)).toBe('just now')
  })

  it('counts up through the units, with the right plural', () => {
    expect(whenText(ago(MIN), now)).toBe('1 minute ago')
    expect(whenText(ago(59 * MIN), now)).toBe('59 minutes ago')
    expect(whenText(ago(HOUR), now)).toBe('1 hour ago')
    expect(whenText(ago(23 * HOUR), now)).toBe('23 hours ago')
    expect(whenText(ago(DAY), now)).toBe('1 day ago')
    expect(whenText(ago(29 * DAY), now)).toBe('29 days ago')
    expect(whenText(ago(30 * DAY), now)).toBe('1 month ago')
    expect(whenText(ago(200 * DAY), now)).toBe('6 months ago')
    expect(whenText(ago(365 * DAY), now)).toBe('1 year ago')
    expect(whenText(ago(800 * DAY), now)).toBe('2 years ago')
  })

  it('is empty when there is no usable time', () => {
    expect(whenText('', now)).toBe('')
    expect(whenText('yesterday', now)).toBe('')
  })
})

describe('issueMeta', () => {
  const now = Date.UTC(2026, 5, 15, 12, 0, 0)
  const issue = (over: Partial<IssueSummary>): IssueSummary => ({
    number: 1,
    title: 't',
    state: 'open',
    author: 'ada',
    labels: [],
    comments: 3,
    updatedAt: new Date(now - 2 * 3_600_000).toISOString(),
    url: 'u',
    ...over,
  })

  it('says who, how many comments and when', () => {
    expect(issueMeta(issue({}), now)).toBe('by ada · 3 comments · updated 2 hours ago')
  })

  it('leaves out what is not known or not there', () => {
    expect(issueMeta(issue({ author: null, comments: 1 }), now)).toBe(
      '1 comment · updated 2 hours ago',
    )
    expect(issueMeta(issue({ comments: 0, updatedAt: '' }), now)).toBe('by ada')
    expect(issueMeta(issue({ author: null, comments: 0, updatedAt: '' }), now)).toBe('')
  })
})
