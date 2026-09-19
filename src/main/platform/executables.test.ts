import { describe, expect, it } from 'vitest'
import {
  commonBinDirs,
  executableCandidates,
  findExecutable,
  pathDirs,
  type ExecutableCheck,
} from './index'

describe('pathDirs', () => {
  it('splits, dedupes and drops empty entries (POSIX)', () => {
    expect(pathDirs('linux', { PATH: '/a::/b:/a' })).toEqual(['/a', '/b'])
  })

  it('handles the Windows "Path" spelling, semicolons and quoted entries', () => {
    expect(pathDirs('win32', { Path: 'C:\\a;"C:\\Program Files\\b";;C:\\a' })).toEqual([
      'C:\\a',
      'C:\\Program Files\\b',
    ])
  })

  it('returns nothing when PATH is missing', () => {
    expect(pathDirs('darwin', {})).toEqual([])
  })
})

describe('executableCandidates', () => {
  it('is just the name on POSIX', () => {
    expect(executableCandidates('claude', 'linux', {})).toEqual(['claude'])
  })

  it('expands PATHEXT on Windows and skips the extensionless npm shim', () => {
    expect(executableCandidates('claude', 'win32', { PATHEXT: '.EXE;.CMD' })).toEqual([
      'claude.exe',
      'claude.cmd',
    ])
  })

  it('leaves a name alone when it already has a runnable extension', () => {
    expect(executableCandidates('claude.exe', 'win32', { PATHEXT: '.EXE;.CMD' })).toEqual([
      'claude.exe',
    ])
  })

  it('falls back to the default PATHEXT', () => {
    expect(executableCandidates('git', 'win32', {})).toEqual([
      'git.com',
      'git.exe',
      'git.bat',
      'git.cmd',
    ])
  })
})

describe('commonBinDirs', () => {
  it('includes Homebrew on macOS but not on Linux', () => {
    expect(commonBinDirs('darwin', '/Users/a', {})).toContain('/opt/homebrew/bin')
    expect(commonBinDirs('linux', '/home/a', {})).not.toContain('/opt/homebrew/bin')
  })

  it('uses APPDATA for the npm global dir on Windows', () => {
    const dirs = commonBinDirs('win32', 'C:\\Users\\a', { APPDATA: 'D:\\Roaming' })
    expect(dirs).toContain('D:\\Roaming\\npm')
  })

  it('derives Windows dirs from the home dir when env vars are absent', () => {
    expect(commonBinDirs('win32', 'C:\\Users\\a', {})).toContain(
      'C:\\Users\\a\\AppData\\Roaming\\npm',
    )
  })
})

describe('findExecutable', () => {
  const only = (...files: string[]): ExecutableCheck => {
    const set = new Set(files)
    return async (file) => set.has(file)
  }

  it('prefers PATH over the common bin dirs', async () => {
    const found = await findExecutable('claude', {
      platform: 'darwin',
      env: { PATH: '/custom/bin' },
      home: '/Users/a',
      isExecutable: only('/custom/bin/claude', '/opt/homebrew/bin/claude'),
    })
    expect(found).toBe('/custom/bin/claude')
  })

  it('finds a tool that is not on PATH via the common bin dirs (Finder-launched app)', async () => {
    const found = await findExecutable('claude', {
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin' },
      home: '/Users/a',
      isExecutable: only('/Users/a/.local/bin/claude'),
    })
    expect(found).toBe('/Users/a/.local/bin/claude')
  })

  it('searches caller-supplied extra dirs last', async () => {
    const found = await findExecutable('claude', {
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      home: '/home/a',
      extraDirs: ['/opt/vendor/bin'],
      isExecutable: only('/opt/vendor/bin/claude'),
    })
    expect(found).toBe('/opt/vendor/bin/claude')
  })

  it('resolves .cmd shims on Windows', async () => {
    const found = await findExecutable('codex', {
      platform: 'win32',
      env: { Path: 'C:\\Users\\a\\AppData\\Roaming\\npm', PATHEXT: '.EXE;.CMD' },
      home: 'C:\\Users\\a',
      isExecutable: only('C:\\Users\\a\\AppData\\Roaming\\npm\\codex.cmd'),
    })
    expect(found).toBe('C:\\Users\\a\\AppData\\Roaming\\npm\\codex.cmd')
  })

  it('returns null when nothing matches', async () => {
    const found = await findExecutable('nope', {
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      home: '/home/a',
      isExecutable: only(),
    })
    expect(found).toBeNull()
  })
})
