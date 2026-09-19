import { describe, expect, it } from 'vitest'
import { isPathInside } from './index'

describe('isPathInside (POSIX)', () => {
  it('accepts the directory itself and descendants', () => {
    expect(isPathInside('/repo', '/repo', 'linux')).toBe(true)
    expect(isPathInside('/repo', '/repo/src/index.ts', 'linux')).toBe(true)
    expect(isPathInside('/repo/', '/repo/src', 'darwin')).toBe(true)
  })

  it('rejects prefix siblings', () => {
    expect(isPathInside('/repo', '/repo-evil', 'linux')).toBe(false)
    expect(isPathInside('/repo', '/repository/x', 'linux')).toBe(false)
  })

  it('rejects .. escapes after normalisation', () => {
    expect(isPathInside('/repo', '/repo/../etc/passwd', 'linux')).toBe(false)
    expect(isPathInside('/repo', '/repo/a/../../etc', 'linux')).toBe(false)
    expect(isPathInside('/repo', '/repo/a/../b', 'linux')).toBe(true)
  })

  it('does not mistake a directory named "..foo" for an escape', () => {
    expect(isPathInside('/repo', '/repo/..foo/bar', 'linux')).toBe(true)
  })

  it('is case-sensitive on POSIX', () => {
    expect(isPathInside('/repo', '/Repo/src', 'linux')).toBe(false)
  })

  it('rejects relative inputs', () => {
    expect(isPathInside('repo', '/repo/src', 'linux')).toBe(false)
    expect(isPathInside('/repo', 'src', 'linux')).toBe(false)
  })
})

describe('isPathInside (Windows semantics)', () => {
  it('accepts descendants using backslashes', () => {
    expect(isPathInside('C:\\work\\repo', 'C:\\work\\repo\\src\\a.ts', 'win32')).toBe(true)
  })

  it('ignores case, including the drive letter', () => {
    expect(isPathInside('C:\\Work\\Repo', 'c:\\work\\repo\\SRC', 'win32')).toBe(true)
  })

  it('rejects a different drive', () => {
    expect(isPathInside('C:\\work\\repo', 'D:\\work\\repo\\src', 'win32')).toBe(false)
  })

  it('rejects prefix siblings and .. escapes', () => {
    expect(isPathInside('C:\\work\\repo', 'C:\\work\\repo-evil', 'win32')).toBe(false)
    expect(isPathInside('C:\\work\\repo', 'C:\\work\\repo\\..\\secrets', 'win32')).toBe(false)
  })

  it('rejects a UNC path outside the drive', () => {
    expect(isPathInside('C:\\work\\repo', '\\\\server\\share\\repo', 'win32')).toBe(false)
  })
})
