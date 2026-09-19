import { describe, expect, it } from 'vitest'
import {
  assertShokubaBranch,
  assertStartPoint,
  cleanAuthorName,
  missionBranch,
  taskBranch,
  workspaceKey,
} from './refs'
import { GitError } from './runner'
import { isSupported, MIN_GIT, parseGitVersion } from './version'

describe('branch names', () => {
  it('are built from plain ids, in separate namespaces for missions and tasks', () => {
    expect(missionBranch('a1b2-c3')).toBe('shokuba/mission/a1b2-c3')
    expect(taskBranch('a1b2-c3')).toBe('shokuba/task/a1b2-c3')
    // Git cannot hold `shokuba/x` and `shokuba/x/y` together, hence two namespaces.
    expect(missionBranch('x').startsWith(taskBranch('x').split('/x')[0] ?? '')).toBe(false)
  })

  it('refuse anything that is not a plain id', () => {
    for (const bad of [
      '',
      '../main',
      'a/b',
      'a b',
      '-rf',
      'a..b',
      'x'.repeat(65),
      'a\nb',
      'a;b',
      '$(x)',
    ]) {
      expect(() => missionBranch(bad), bad).toThrow(GitError)
      expect(() => taskBranch(bad), bad).toThrow(GitError)
      expect(() => workspaceKey(bad), bad).toThrow(GitError)
    }
  })

  it('are the only names anything may change', () => {
    expect(assertShokubaBranch('shokuba/task/abc')).toBe('shokuba/task/abc')
    for (const bad of [
      'main',
      'master',
      'HEAD',
      'refs/heads/main',
      'shokuba/task/../main',
      'shokuba/other/x',
      'shokuba/task/',
      'shokuba/task/a/b',
    ]) {
      expect(() => assertShokubaBranch(bad), bad).toThrow(GitError)
    }
  })
})

describe('start points', () => {
  it('are full commit ids or Shokuba branches, and never a revision expression', () => {
    const sha1 = 'a'.repeat(40)
    const sha256 = 'b'.repeat(64)
    expect(assertStartPoint(sha1)).toBe(sha1)
    expect(assertStartPoint(sha256)).toBe(sha256)
    expect(assertStartPoint('shokuba/mission/m1')).toBe('shokuba/mission/m1')
    for (const bad of [
      'HEAD',
      'main',
      'HEAD~1',
      'abc123',
      'a'.repeat(39),
      '--output=x',
      'main..other',
      '@{u}',
    ]) {
      expect(() => assertStartPoint(bad), bad).toThrow(GitError)
    }
  })
})

describe('commit author names', () => {
  it('are one printable line without angle brackets', () => {
    expect(cleanAuthorName('Ren')).toBe('Ren')
    expect(cleanAuthorName('  <Ren>\n')).toBe('Ren')
    expect(cleanAuthorName('Ren' + String.fromCharCode(0, 27) + 'X')).toBe('RenX')
    expect(cleanAuthorName('x'.repeat(200))).toHaveLength(60)
  })

  it('fall back to Shokuba when nothing is left', () => {
    expect(cleanAuthorName('<>')).toBe('Shokuba')
    expect(cleanAuthorName('')).toBe('Shokuba')
  })
})

describe('Git versions', () => {
  it('are read from the different ways Git reports them', () => {
    expect(parseGitVersion('git version 2.55.0')).toEqual({ text: '2.55.0', major: 2, minor: 55 })
    expect(parseGitVersion('git version 2.39.5 (Apple Git-154)')).toMatchObject({
      major: 2,
      minor: 39,
    })
    expect(parseGitVersion('git version 2.45.1.windows.1')).toMatchObject({ major: 2, minor: 45 })
    expect(parseGitVersion('not git')).toBeNull()
  })

  it(`must be ${MIN_GIT.join('.')} or newer`, () => {
    const v = (major: number, minor: number) => ({ text: `${major}.${minor}`, major, minor })
    expect(isSupported(v(2, 39))).toBe(false)
    expect(isSupported(v(2, 40))).toBe(true)
    expect(isSupported(v(2, 55))).toBe(true)
    expect(isSupported(v(3, 0))).toBe(true)
    expect(isSupported(v(1, 99))).toBe(false)
  })
})
