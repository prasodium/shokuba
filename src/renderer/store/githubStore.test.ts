import { describe, expect, it } from 'vitest'
import type {
  GitHubLink,
  GitHubProject,
  GitHubStatus,
  IssueSummary,
  PullPreview,
  PullStatus,
} from '@shared/github'
import { createGitHubStore, type GitHubApi } from './githubStore'

const project: GitHubProject = { repoRoot: '/work/widgets', name: 'widgets', repo: 'octo/widgets' }
const issue = (number: number): IssueSummary => ({
  number,
  title: `Issue ${number}`,
  state: 'open',
  author: 'ada',
  labels: [],
  comments: 0,
  updatedAt: '2026-03-01T10:00:00.000Z',
  url: `https://github.com/octo/widgets/issues/${number}`,
})
const link = (number: number): GitHubLink => ({
  missionId: `m${number}`,
  repo: 'octo/widgets',
  repoRoot: '/work/widgets',
  issueNumber: number,
  issueTitle: `Issue ${number}`,
  issueUrl: `https://github.com/octo/widgets/issues/${number}`,
  issueAuthor: 'ada',
  issueBody: '',
  importedAt: 't',
  pullRequest: null,
})

const api = (over: Partial<GitHubApi> = {}): GitHubApi => ({
  status: async () => ({ state: 'ready', login: 'octocat' }),
  projects: async () => [project],
  issues: async () => [issue(1), issue(2)],
  importIssue: async ({ number }) => link(number),
  links: async () => [],
  askToPlan: async () => undefined,
  takeBackPlan: async () => undefined,
  pullPreview: async () => ({}) as PullPreview,
  pullOpen: async () => ({ number: 7, url: 'u', draft: true, existing: false }),
  pullStatus: async () => ({}) as PullStatus,
  pullFollowUp: async () => ({ taskId: 't1', reopened: true }),
  ...over,
})

/** A promise you settle yourself, to make answers arrive in the order a test wants. */
function later<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('check', () => {
  it('finds out who is signed in and which projects are on GitHub', async () => {
    const store = createGitHubStore(api())
    expect(store.getState().status).toBeNull()
    await store.getState().check()
    expect(store.getState().status).toEqual({ state: 'ready', login: 'octocat' })
    expect(store.getState().projects).toEqual([project])
  })

  it('does not look for projects when GitHub cannot be used', async () => {
    let asked = false
    const store = createGitHubStore(
      api({
        status: async () => ({ state: 'signed-out' }),
        projects: async () => {
          asked = true
          return [project]
        },
      }),
    )
    await store.getState().check()
    expect(store.getState().status).toEqual({ state: 'signed-out' })
    expect(store.getState().projects).toEqual([])
    expect(asked).toBe(false)
  })

  it('turns a failure into a status, so there is always something to show', async () => {
    const store = createGitHubStore(
      api({
        status: async () => {
          throw new Error("Error invoking remote method 'shokuba:github:status': Error: boom")
        },
      }),
    )
    await store.getState().check()
    expect(store.getState().status).toEqual({ state: 'error', message: 'boom' })
  })

  it('shows why the projects could not be read', async () => {
    const store = createGitHubStore(
      api({
        projects: async () => {
          throw new Error('folders unreadable')
        },
      }),
    )
    await store.getState().check()
    expect(store.getState().error).toBe('folders unreadable')
  })

  it('starts afresh each time, clearing what was there', async () => {
    const pending = later<GitHubStatus>()
    let first = true
    const store = createGitHubStore(
      api({
        status: () => {
          if (!first) return pending.promise
          first = false
          return Promise.resolve({ state: 'ready', login: 'octocat' })
        },
      }),
    )
    await store.getState().check()
    await store.getState().loadIssues(project.repoRoot, 'open')
    expect(store.getState().issues).toHaveLength(2)

    const again = store.getState().check()
    expect(store.getState()).toMatchObject({
      status: null,
      projects: [],
      issues: [],
      issuesOf: null,
      error: null,
    })
    pending.resolve({ state: 'missing' })
    await again
    expect(store.getState().status).toEqual({ state: 'missing' })
  })

  it('ignores an older check that finishes after a newer one', async () => {
    const slow = later<GitHubStatus>()
    let calls = 0
    const store = createGitHubStore(
      api({
        status: () => (calls++ === 0 ? slow.promise : Promise.resolve({ state: 'missing' })),
      }),
    )
    const first = store.getState().check()
    await store.getState().check()
    expect(store.getState().status).toEqual({ state: 'missing' })
    slow.resolve({ state: 'ready', login: 'late' })
    await first
    expect(store.getState().status).toEqual({ state: 'missing' })
    expect(store.getState().projects).toEqual([])
  })
})

describe('check, when the projects are slow', () => {
  it('ignores an older list of projects that arrives after a newer check', async () => {
    const slow = later<GitHubProject[]>()
    const other: GitHubProject = { repoRoot: '/work/gears', name: 'gears', repo: 'octo/gears' }
    let calls = 0
    const store = createGitHubStore(
      api({ projects: () => (calls++ === 0 ? slow.promise : Promise.resolve([other])) }),
    )
    const first = store.getState().check()
    await Promise.resolve()
    await store.getState().check()
    expect(store.getState().projects).toEqual([other])
    slow.resolve([project])
    await first
    expect(store.getState().projects).toEqual([other])
  })

  it('ignores an older failure to read the projects as well', async () => {
    const slow = later<GitHubProject[]>()
    let calls = 0
    const store = createGitHubStore(
      api({ projects: () => (calls++ === 0 ? slow.promise : Promise.resolve([project])) }),
    )
    const first = store.getState().check()
    await Promise.resolve()
    await store.getState().check()
    slow.reject(new Error('late failure'))
    await first
    expect(store.getState().error).toBeNull()
    expect(store.getState().projects).toEqual([project])
  })
})

describe('loadIssues', () => {
  it('reads a project’s issues and remembers what they are of', async () => {
    const seen: unknown[] = []
    const store = createGitHubStore(
      api({
        issues: async (input) => {
          seen.push(input)
          return [issue(5)]
        },
      }),
    )
    await store.getState().loadIssues('/work/widgets', 'closed')
    expect(seen).toEqual([{ repoRoot: '/work/widgets', state: 'closed' }])
    expect(store.getState()).toMatchObject({
      issues: [issue(5)],
      issuesOf: { repoRoot: '/work/widgets', state: 'closed' },
      loading: false,
      error: null,
    })
  })

  it('is loading while it waits', async () => {
    const pending = later<IssueSummary[]>()
    const store = createGitHubStore(api({ issues: () => pending.promise }))
    const load = store.getState().loadIssues('/x', 'open')
    expect(store.getState().loading).toBe(true)
    pending.resolve([])
    await load
    expect(store.getState().loading).toBe(false)
  })

  it('shows the reason and no issues when it fails', async () => {
    const store = createGitHubStore(
      api({
        issues: async () => {
          throw new Error("Error invoking remote method 'x': Error: GitHub could not be reached.")
        },
      }),
    )
    await store.getState().loadIssues('/x', 'open')
    expect(store.getState()).toMatchObject({
      issues: [],
      issuesOf: null,
      loading: false,
      error: 'GitHub could not be reached.',
    })
  })

  it('clears an old error when it tries again', async () => {
    let fail = true
    const store = createGitHubStore(
      api({
        issues: async () => {
          if (fail) throw new Error('nope')
          return [issue(1)]
        },
      }),
    )
    await store.getState().loadIssues('/x', 'open')
    expect(store.getState().error).toBe('nope')
    fail = false
    await store.getState().loadIssues('/x', 'open')
    expect(store.getState().error).toBeNull()
  })

  it('shows only the newest read: a slow answer for an earlier choice does not replace it', async () => {
    const slow = later<IssueSummary[]>()
    const store = createGitHubStore(
      api({
        issues: ({ state }) => (state === 'open' ? slow.promise : Promise.resolve([issue(9)])),
      }),
    )
    const first = store.getState().loadIssues('/x', 'open')
    await store.getState().loadIssues('/x', 'closed')
    slow.resolve([issue(1)])
    await first
    expect(store.getState().issues).toEqual([issue(9)])
    expect(store.getState().issuesOf).toEqual({ repoRoot: '/x', state: 'closed' })
    expect(store.getState().loading).toBe(false)
  })

  it('ignores a slow failure of an earlier read', async () => {
    const slow = later<IssueSummary[]>()
    const store = createGitHubStore(
      api({
        issues: ({ state }) => (state === 'open' ? slow.promise : Promise.resolve([issue(9)])),
      }),
    )
    const first = store.getState().loadIssues('/x', 'open')
    await store.getState().loadIssues('/x', 'closed')
    slow.reject(new Error('late failure'))
    await first
    expect(store.getState().error).toBeNull()
    expect(store.getState().issues).toEqual([issue(9)])
  })

  it('drops what a check that started later cleared, when an older read lands', async () => {
    const slow = later<IssueSummary[]>()
    const store = createGitHubStore(api({ issues: () => slow.promise }))
    const load = store.getState().loadIssues('/x', 'open')
    await store.getState().check()
    slow.resolve([issue(1)])
    await load
    expect(store.getState().issues).toEqual([])
  })
})

describe('importIssue', () => {
  it('imports, then reads the links again so the new mission shows', async () => {
    let imported = false
    const store = createGitHubStore(
      api({
        importIssue: async ({ number }) => {
          imported = true
          return link(number)
        },
        links: async () => (imported ? [link(7)] : []),
      }),
    )
    const outcome = await store.getState().importIssue('/work/widgets', 7)
    expect(outcome).toEqual({ ok: true, value: link(7) })
    expect(store.getState().links).toEqual([link(7)])
  })

  it('sends the project and the number, and says why it failed without changing the links', async () => {
    const sent: unknown[] = []
    const store = createGitHubStore(
      api({
        importIssue: async (input) => {
          sent.push(input)
          throw new Error(
            "Error invoking remote method 'x': GitHubError: Issue #7 is already a mission",
          )
        },
        links: async () => [link(1)],
      }),
    )
    const outcome = await store.getState().importIssue('/work/widgets', 7)
    expect(sent).toEqual([{ repoRoot: '/work/widgets', number: 7 }])
    expect(outcome).toEqual({ ok: false, error: 'Issue #7 is already a mission' })
    expect(store.getState().links).toEqual([])
  })
})

describe('refreshLinks', () => {
  it('reads them, and keeps what it had if it cannot', async () => {
    let fail = false
    const store = createGitHubStore(
      api({
        links: async () => {
          if (fail) throw new Error('no')
          return [link(1)]
        },
      }),
    )
    await store.getState().refreshLinks()
    expect(store.getState().links).toEqual([link(1)])
    fail = true
    await store.getState().refreshLinks()
    expect(store.getState().links).toEqual([link(1)])
  })
})

describe('askToPlan and takeBackPlan', () => {
  it('hand a draft to a manager, sending the mission and the manager', async () => {
    const sent: unknown[] = []
    const store = createGitHubStore(
      api({
        askToPlan: async (missionId, managerId) => {
          sent.push({ missionId, managerId })
        },
      }),
    )
    expect(await store.getState().askToPlan('m1', 'mira')).toEqual({ ok: true, value: undefined })
    expect(sent).toEqual([{ missionId: 'm1', managerId: 'mira' }])
  })

  it('say why it was refused, without the wrapper Electron adds', async () => {
    const store = createGitHubStore(
      api({
        askToPlan: async () => {
          throw new Error(
            "Error invoking remote method 'x': GitHubError: Only a manager can be asked to plan",
          )
        },
        takeBackPlan: async () => {
          throw new Error('There is no such mission')
        },
      }),
    )
    expect(await store.getState().askToPlan('m1', 'ren')).toEqual({
      ok: false,
      error: 'Only a manager can be asked to plan',
    })
    expect(await store.getState().takeBackPlan('nope')).toEqual({
      ok: false,
      error: 'There is no such mission',
    })
  })

  it('take a draft back', async () => {
    const taken: string[] = []
    const store = createGitHubStore(
      api({
        takeBackPlan: async (missionId) => {
          taken.push(missionId)
        },
      }),
    )
    expect(await store.getState().takeBackPlan('m1')).toEqual({ ok: true, value: undefined })
    expect(taken).toEqual(['m1'])
  })
})

describe('pullPreview and pullOpen', () => {
  it('preview hands back what the main process worked out, and asks it about that mission only', async () => {
    const asked: string[] = []
    const preview = { hash: 'h', problems: [] } as unknown as PullPreview
    const store = createGitHubStore(
      api({
        pullPreview: async (missionId) => {
          asked.push(missionId)
          return preview
        },
      }),
    )
    expect(await store.getState().pullPreview('m1')).toEqual({ ok: true, value: preview })
    expect(asked).toEqual(['m1'])
  })

  it('preview says why it could not be made, without the wrapper Electron adds', async () => {
    const store = createGitHubStore(
      api({
        pullPreview: async () => {
          throw new Error(
            "Error invoking remote method 'x': GitHubError: That mission does not come from a GitHub issue",
          )
        },
      }),
    )
    expect(await store.getState().pullPreview('m1')).toEqual({
      ok: false,
      error: 'That mission does not come from a GitHub issue',
    })
  })

  it('open sends the mission, the hash it was shown and the draft choice, then reads the links again', async () => {
    const sent: unknown[] = []
    let opened = false
    const store = createGitHubStore(
      api({
        pullOpen: async (input) => {
          sent.push(input)
          opened = true
          return {
            number: 7,
            url: 'https://github.com/acme/widgets/pull/7',
            draft: false,
            existing: false,
          }
        },
        links: async () => (opened ? [link(1)] : []),
      }),
    )
    const outcome = await store.getState().pullOpen('m1', 'a'.repeat(64), false)
    expect(sent).toEqual([{ missionId: 'm1', hash: 'a'.repeat(64), draft: false }])
    expect(outcome).toMatchObject({ ok: true, value: { number: 7 } })
    expect(store.getState().links).toEqual([link(1)])
  })

  it('open says why it was refused, and still reads the links again, since the branch may have been pushed', async () => {
    let reads = 0
    const store = createGitHubStore(
      api({
        pullOpen: async () => {
          throw new Error('Something changed since you looked at this')
        },
        links: async () => {
          reads += 1
          return []
        },
      }),
    )
    expect(await store.getState().pullOpen('m1', 'a'.repeat(64), true)).toEqual({
      ok: false,
      error: 'Something changed since you looked at this',
    })
    expect(reads).toBe(1)
  })
})

describe('pullStatus and pullFollowUp', () => {
  it('status asks about that mission and hands back what was read', async () => {
    const asked: string[] = []
    const status = { state: 'open' } as unknown as PullStatus
    const store = createGitHubStore(
      api({
        pullStatus: async (missionId) => {
          asked.push(missionId)
          return status
        },
      }),
    )
    expect(await store.getState().pullStatus('m1')).toEqual({ ok: true, value: status })
    expect(asked).toEqual(['m1'])
  })

  it('status says why it could not read, without the wrapper Electron adds', async () => {
    const store = createGitHubStore(
      api({
        pullStatus: async () => {
          throw new Error("Error invoking remote method 'x': GhError: GitHub could not be reached.")
        },
      }),
    )
    expect(await store.getState().pullStatus('m1')).toEqual({
      ok: false,
      error: 'GitHub could not be reached.',
    })
  })

  it('follow-up sends exactly the request, and gives back the task made', async () => {
    const sent: unknown[] = []
    const store = createGitHubStore(
      api({
        pullFollowUp: async (request) => {
          sent.push(request)
          return { taskId: 't9', reopened: false }
        },
      }),
    )
    const outcome = await store
      .getState()
      .pullFollowUp({ missionId: 'm1', kind: 'check', ref: 'run:12' })
    expect(sent).toEqual([{ missionId: 'm1', kind: 'check', ref: 'run:12' }])
    expect(outcome).toEqual({ ok: true, value: { taskId: 't9', reopened: false } })
  })

  it('follow-up says why it was refused', async () => {
    const store = createGitHubStore(
      api({
        pullFollowUp: async () => {
          throw new Error('GitHubError: That check is not failing any more.')
        },
      }),
    )
    expect(
      await store.getState().pullFollowUp({ missionId: 'm1', kind: 'check', ref: 'run:12' }),
    ).toEqual({
      ok: false,
      error: 'That check is not failing any more.',
    })
  })
})
