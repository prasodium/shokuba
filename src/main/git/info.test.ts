import { describe, expect, it } from 'vitest'
import { readGitInfo } from './info'
import { GitError } from './runner'
import { MIN_GIT } from './version'

const minimum = MIN_GIT.join('.')

describe('what Shokuba says about Git', () => {
  it('names the version it found, and the minimum', async () => {
    const git = { version: async () => ({ text: '2.45.1', major: 2, minor: 45 }) }
    expect(await readGitInfo(git, undefined)).toEqual({
      state: 'ready',
      version: '2.45.1',
      minimum,
    })
  })

  it('says why, when Git could not be used at startup', async () => {
    const reason = 'Git 2.39 is too old: Shokuba needs 2.40 or newer.'
    expect(await readGitInfo(undefined, reason)).toEqual({ state: 'unavailable', reason, minimum })
  })

  it('still says something when no reason was recorded', async () => {
    expect(await readGitInfo(undefined, undefined)).toEqual({
      state: 'unavailable',
      reason: 'Git could not be used',
      minimum,
    })
  })

  it("passes on Git's own complaint, and hides anything else", async () => {
    const said = { version: () => Promise.reject(new GitError('failed', 'Could not tell')) }
    expect(await readGitInfo(said, undefined)).toMatchObject({ reason: 'Could not tell' })
    const other = { version: () => Promise.reject(new Error('/Users/me/secret path')) }
    expect(await readGitInfo(other, undefined)).toMatchObject({ reason: 'Git could not be used' })
  })
})
