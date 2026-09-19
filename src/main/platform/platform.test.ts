import { describe, expect, it } from 'vitest'
import {
  defaultShell,
  getEnv,
  INTERRUPT_SEQUENCE,
  ipcEndpoint,
  pathApi,
  planTerminate,
  toPlatformId,
  UnsupportedPlatformError,
} from './index'

describe('toPlatformId', () => {
  it('accepts the three supported platforms', () => {
    expect(toPlatformId('darwin')).toBe('darwin')
    expect(toPlatformId('win32')).toBe('win32')
    expect(toPlatformId('linux')).toBe('linux')
  })

  it('rejects anything else with a clear error', () => {
    expect(() => toPlatformId('freebsd')).toThrow(UnsupportedPlatformError)
  })
})

describe('pathApi', () => {
  it('returns Windows semantics on a POSIX host', () => {
    expect(pathApi('win32').join('C:\\Users\\a', 'b')).toBe('C:\\Users\\a\\b')
    expect(pathApi('linux').join('/home/a', 'b')).toBe('/home/a/b')
  })
})

describe('getEnv', () => {
  it('is case-insensitive on Windows only', () => {
    const env = { Path: 'C:\\bin' }
    expect(getEnv(env, 'PATH', 'win32')).toBe('C:\\bin')
    expect(getEnv(env, 'PATH', 'linux')).toBeUndefined()
  })
})

describe('defaultShell', () => {
  it('uses $SHELL on POSIX when it is an absolute path', () => {
    expect(defaultShell('darwin', { SHELL: '/opt/homebrew/bin/fish' }).file).toBe(
      '/opt/homebrew/bin/fish',
    )
  })

  it('falls back to a sensible shell per platform', () => {
    expect(defaultShell('darwin', {}).file).toBe('/bin/zsh')
    expect(defaultShell('linux', {}).file).toBe('/bin/bash')
  })

  it('ignores a relative or garbage $SHELL', () => {
    expect(defaultShell('linux', { SHELL: 'bash' }).file).toBe('/bin/bash')
  })

  it('uses PowerShell on Windows and ignores $SHELL', () => {
    expect(defaultShell('win32', { SHELL: '/bin/bash' }).file).toBe('powershell.exe')
  })
})

describe('ipcEndpoint', () => {
  it('uses a named pipe on Windows', () => {
    expect(ipcEndpoint('win32', 'signals', 'ignored')).toBe('\\\\.\\pipe\\shokuba-signals')
  })

  it('uses a unix socket under the temp dir on POSIX', () => {
    expect(ipcEndpoint('darwin', 'signals', '/tmp')).toBe('/tmp/shokuba-signals.sock')
    expect(ipcEndpoint('linux', 'signals', '/run/user/1000')).toBe(
      '/run/user/1000/shokuba-signals.sock',
    )
  })

  it('strips characters that could escape the path', () => {
    expect(ipcEndpoint('linux', '../../etc/passwd', '/tmp')).toBe('/tmp/shokuba-etcpasswd.sock')
  })

  it('rejects an empty name', () => {
    expect(() => ipcEndpoint('linux', '///', '/tmp')).toThrow(/Invalid IPC endpoint name/)
  })

  it('rejects socket paths longer than sun_path allows', () => {
    const longDir = `/${'a'.repeat(120)}`
    expect(() => ipcEndpoint('darwin', 'signals', longDir)).toThrow(/too long/)
  })
})

describe('planTerminate', () => {
  it('signals the process group on POSIX', () => {
    expect(planTerminate('darwin', 4242, 'graceful')).toEqual({
      kind: 'signal-group',
      pid: 4242,
      signal: 'SIGTERM',
    })
    expect(planTerminate('linux', 4242, 'force')).toEqual({
      kind: 'signal-group',
      pid: 4242,
      signal: 'SIGKILL',
    })
  })

  it('uses taskkill /T on Windows, adding /F only when forced', () => {
    expect(planTerminate('win32', 4242, 'graceful')).toEqual({
      kind: 'taskkill',
      command: 'taskkill',
      args: ['/pid', '4242', '/T'],
    })
    expect(planTerminate('win32', 4242, 'force')).toEqual({
      kind: 'taskkill',
      command: 'taskkill',
      args: ['/pid', '4242', '/T', '/F'],
    })
  })

  it.each([0, 1, -5, 1.5, Number.NaN])('refuses to target pid %s', (pid) => {
    expect(() => planTerminate('linux', pid, 'force')).toThrow(/Refusing/)
  })
})

describe('INTERRUPT_SEQUENCE', () => {
  it('is Ctrl+C', () => {
    expect(INTERRUPT_SEQUENCE).toBe('\u0003')
  })
})
