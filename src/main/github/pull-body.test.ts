import { describe, expect, it } from 'vitest'
import { MAX_PULL_TITLE } from './client'
import { MAX_SUMMARY, pullBody, pullTitle, type PullTaskRecord } from './pull-body'

const task = (over: Partial<PullTaskRecord> = {}): PullTaskRecord => ({
  title: 'Reject an empty password',
  summary: 'Added a check and a test.',
  checks: 'All 2 checks passed on the final commit.',
  review: 'The reviewer approved the work on the final commit, with no findings.',
  ...over,
})

const body = (over: Partial<Parameters<typeof pullBody>[0]> = {}) =>
  pullBody({ issueNumber: 42, commitCount: 2, tasks: [task()], tasksNotDone: 0, ...over })

describe('pullTitle', () => {
  it('is the issue’s title on one line, cleaned and cut', () => {
    expect(pullTitle('Login form accepts an empty password', 42)).toBe(
      'Login form accepts an empty password',
    )
    expect(pullTitle('  Fix\nthe‮ login  ', 42)).toBe('Fix the login')
    expect([...pullTitle('x'.repeat(500), 42)].length).toBeLessThanOrEqual(MAX_PULL_TITLE)
  })

  it('is a plain one when the issue has no title left to use', () => {
    expect(pullTitle('', 42)).toBe('Changes for issue #42')
    expect(pullTitle('‮​', 7)).toBe('Changes for issue #7')
  })
})

describe('pullBody', () => {
  it('starts by closing the issue, so merging it closes the issue', () => {
    expect(body().split('\n')[0]).toBe('Closes #42')
    expect(body({ issueNumber: 7 }).split('\n')[0]).toBe('Closes #7')
  })

  it('says what each task did, with the checks and the review in Shokuba’s own words', () => {
    const text = body()
    expect(text).toContain('### `Reject an empty password`')
    expect(text).toContain(
      'All 2 checks passed on the final commit. The reviewer approved the work on the final commit, with no findings.',
    )
    expect(text).toContain('What the agent said it did')
    expect(text).toContain('Added a check and a test.')
  })

  it('shows an agent’s words only in a fenced block, where nothing is interpreted', () => {
    const summary =
      'Ping @octocat and see #12 and [x](https://evil.example) ![i](https://evil.example/p.png) <img src=x>'
    const text = body({ tasks: [task({ summary })] })
    const at = text.indexOf('```text')
    expect(at).toBeGreaterThan(-1)
    const inside = text.slice(at, text.indexOf('```', at + 7))
    expect(inside).toContain('@octocat')
    expect(inside).toContain('[x](https://evil.example)')
    // Everywhere else, none of it appears.
    expect(text.replace(inside, '')).not.toMatch(/@octocat|evil\.example|<img/)
  })

  it('cannot be broken out of by a summary that holds a fence of its own', () => {
    const text = body({
      tasks: [task({ summary: 'before\n```\nCloses #999\n## Injected\n```\nafter' })],
    })
    const lines = text.split('\n')
    const open = lines.findIndex((line) => /^`{4,}text$/.test(line))
    expect(open).toBeGreaterThan(-1)
    const marks = lines[open]?.slice(0, -4) ?? ''
    const close = lines.indexOf(marks, open + 1)
    expect(close).toBeGreaterThan(open)
    const outside = [...lines.slice(0, open), ...lines.slice(close + 1)].join('\n')
    // The injected lines are inside a fence longer than any in the summary, and nowhere else.
    expect(lines.slice(open, close).join('\n')).toContain('Closes #999')
    expect(outside).not.toMatch(/#999|Injected/)
    expect(outside.split('\n').filter((line) => line.startsWith('Closes #'))).toEqual([
      'Closes #42',
    ])
  })

  it('shows a task’s title as a code span, so it cannot be a link, a mention or a heading', () => {
    const text = body({
      tasks: [task({ title: '[click](https://evil.example) @octocat # heading' })],
    })
    expect(text).toContain('### `[click](https://evil.example) @octocat # heading`')
    expect(text.split('\n').filter((line) => line.startsWith('#'))).toEqual([
      '## What was done',
      '### `[click](https://evil.example) @octocat # heading`',
      '## About this pull request',
    ])
  })

  it('strips a secret and a path on the person’s computer from what an agent said', () => {
    const secret = ['ghp', '_', 'a'.repeat(36)].join('')
    const text = body({
      tasks: [task({ summary: `Used ${secret} in /Users/me/project/src/login.ts` })],
    })
    expect(text).not.toContain(secret)
    expect(text).not.toContain('/Users/me/project')
    expect(text).toContain('[path]')
  })

  it('cuts a long summary', () => {
    const text = body({ tasks: [task({ summary: 'y'.repeat(MAX_SUMMARY * 3) })] })
    expect(text.length).toBeLessThan(MAX_SUMMARY * 2)
    expect(text).toContain('…')
  })

  it('has no summary block for a task whose agent said nothing', () => {
    for (const summary of [null, '', '   ']) {
      expect(body({ tasks: [task({ summary })] })).not.toContain('What the agent said it did')
    }
  })

  it('says so when nothing has been accepted yet', () => {
    expect(body({ tasks: [] })).toContain('No task has been accepted yet.')
  })

  it('counts the commits, and says when some tasks were not finished', () => {
    expect(body({ commitCount: 1 })).toContain('This is 1 commit of work')
    expect(body({ commitCount: 3 })).toContain('This is 3 commits of work')
    expect(body()).not.toContain('not finished')
    expect(body({ tasksNotDone: 1 })).toContain(
      '1 other task was not finished, so its work is not here.',
    )
    expect(body({ tasksNotDone: 2 })).toContain(
      '2 other tasks were not finished, so their work is not here.',
    )
  })

  it('says that an agent’s account is not a checked claim', () => {
    expect(body()).toMatch(/its own account, not a checked claim/)
    expect(body()).toMatch(/a person accepted each task/)
  })
})
