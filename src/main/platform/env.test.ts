import { describe, expect, it } from 'vitest'
import { pickEnv, safeChildEnv } from './index'

describe('safeChildEnv (POSIX)', () => {
  const parent = {
    PATH: '/usr/bin',
    HOME: '/home/a',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    ANTHROPIC_API_KEY: 'do-not-leak',
    AWS_SECRET_ACCESS_KEY: 'do-not-leak',
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: '--inspect',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
  }

  it('keeps only allow-listed variables', () => {
    expect(safeChildEnv('linux', parent)).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/a',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
    })
  })

  it('drops Shokuba/Electron runtime flags that change how child tools behave', () => {
    const env = safeChildEnv('darwin', parent)
    expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(env).not.toHaveProperty('NODE_OPTIONS')
  })

  it('lets callers add secrets explicitly, and explicit values win', () => {
    const env = safeChildEnv('linux', parent, { ANTHROPIC_API_KEY: 'from-keychain', HOME: '/x' })
    expect(env['ANTHROPIC_API_KEY']).toBe('from-keychain')
    expect(env['HOME']).toBe('/x')
  })

  it('skips undefined values', () => {
    expect(safeChildEnv('linux', { PATH: undefined, HOME: '/h' })).toEqual({ HOME: '/h' })
  })
})

describe('safeChildEnv (Windows)', () => {
  const parent = {
    Path: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\a',
    OPENAI_API_KEY: 'do-not-leak',
    ELECTRON_RUN_AS_NODE: '1',
  }

  it('matches names case-insensitively and preserves the original spelling', () => {
    expect(safeChildEnv('win32', parent)).toEqual({
      Path: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\a',
    })
  })

  it('replaces an inherited variable that differs only by case', () => {
    const env = safeChildEnv('win32', parent, { PATH: 'C:\\custom' })
    expect(env).not.toHaveProperty('Path')
    expect(env['PATH']).toBe('C:\\custom')
  })
})

describe('pickEnv', () => {
  it('takes only the named variables, and leaves out the ones that are missing or empty', () => {
    const parent = { A: '1', B: '', C: '3', SECRET_TOKEN: 'x' }
    expect(pickEnv('linux', parent, ['A', 'B', 'D', 'C'])).toEqual({ A: '1', C: '3' })
  })

  it('treats two spellings as two settings where names are case-sensitive', () => {
    const parent = { HTTPS_PROXY: 'upper', https_proxy: 'lower' }
    expect(pickEnv('linux', parent, ['HTTPS_PROXY', 'https_proxy'])).toEqual({
      HTTPS_PROXY: 'upper',
      https_proxy: 'lower',
    })
    expect(pickEnv('darwin', { https_proxy: 'lower' }, ['HTTPS_PROXY', 'https_proxy'])).toEqual({
      https_proxy: 'lower',
    })
  })

  it('passes a setting once on Windows, where the spellings are one, under the name asked for', () => {
    expect(pickEnv('win32', { Https_Proxy: 'p' }, ['HTTPS_PROXY', 'https_proxy'])).toEqual({
      HTTPS_PROXY: 'p',
    })
  })

  it('is empty when nothing is named', () => {
    expect(pickEnv('linux', { A: '1' }, [])).toEqual({})
  })
})
