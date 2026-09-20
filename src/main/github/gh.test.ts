import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { toPlatformId } from '../platform'
import { GhCli, GhError, interpretFailure, type GhCliOptions } from './gh'
import { fakeGh, type FakeGh } from './testing/fake'

const dirs: string[] = []
const fakes: FakeGh[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const fake of fakes.splice(0)) fake.cleanup()
})

/** A `GhCli` running the stand-in `gh` with `env` as Shokuba's own environment. */
function cli(
  env: Record<string, string> = {},
  options: Partial<GhCliOptions> = {},
): { gh: GhCli; fake: FakeGh } {
  const home = mkdtempSync(path.join(tmpdir(), 'shokuba-gh-'))
  dirs.push(home)
  const fake = fakeGh({ login: 'octocat' })
  fakes.push(fake)
  const gh = new GhCli({
    platform: toPlatformId(),
    env: { PATH: process.env.PATH ?? '', HOME: home, ...env },
    home,
    executable: fake.executable,
    prefixArgs: fake.prefixArgs,
    ...options,
  })
  return { gh, fake }
}

async function failure(promise: Promise<unknown>): Promise<GhError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(GhError)
    return error as GhError
  }
  throw new Error('expected it to fail')
}

describe('GhCli', () => {
  it('runs gh and gives back what it printed', async () => {
    expect(await cli().gh.run(['--version'])).toMatch(/^gh version/)
  })

  it('never lets a token reach gh, however the parent environment is set', async () => {
    const secret = ['tok', 'en', '-value-', '123'].join('')
    const parent = {
      GH_TOKEN: secret,
      GITHUB_TOKEN: secret,
      GH_ENTERPRISE_TOKEN: secret,
      GITHUB_ENTERPRISE_TOKEN: secret,
      GH_HOST: 'evil.example',
      ANTHROPIC_API_KEY: secret,
      AWS_SECRET_ACCESS_KEY: secret,
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      NODE_OPTIONS: '--max-old-space-size=1',
      ELECTRON_RUN_AS_NODE: '1',
    }
    const given = JSON.parse(await cli(parent).gh.run(['env-dump'])) as Record<string, string>
    for (const name of Object.keys(parent)) expect(given[name], name).toBeUndefined()
    expect(JSON.stringify(given)).not.toContain(secret)
  })

  it('passes on where gh keeps its login and the network settings, and only those', async () => {
    const parent = {
      XDG_CONFIG_HOME: '/home/x/.config',
      GH_CONFIG_DIR: '/home/x/gh',
      HTTPS_PROXY: 'http://proxy.example:3128',
      NO_PROXY: 'localhost',
      SSL_CERT_FILE: '/etc/ca.pem',
      SOMETHING_ELSE: 'no',
    }
    const given = JSON.parse(await cli(parent).gh.run(['env-dump'])) as Record<string, string>
    expect(given.XDG_CONFIG_HOME).toBe('/home/x/.config')
    expect(given.GH_CONFIG_DIR).toBe('/home/x/gh')
    expect(given.HTTPS_PROXY).toBe('http://proxy.example:3128')
    expect(given.NO_PROXY).toBe('localhost')
    expect(given.SSL_CERT_FILE).toBe('/etc/ca.pem')
    expect(given.SOMETHING_ELSE).toBeUndefined()
  })

  it('passes a setting once on Windows, where HTTPS_PROXY and https_proxy are the same, and as it is elsewhere', async () => {
    const dump = async (platform: 'win32' | 'linux', name: string) =>
      JSON.parse(
        await cli({ [name]: 'http://proxy.example:3128' }, { platform }).gh.run(['env-dump']),
      ) as Record<string, string>
    const windows = await dump('win32', 'Https_Proxy')
    expect(Object.keys(windows).filter((k) => k.toLowerCase() === 'https_proxy')).toEqual([
      'HTTPS_PROXY',
    ])
    expect(windows.HTTPS_PROXY).toBe('http://proxy.example:3128')
    const elsewhere = await dump('linux', 'https_proxy')
    expect(elsewhere.https_proxy).toBe('http://proxy.example:3128')
    expect(elsewhere.HTTPS_PROXY).toBeUndefined()
  })

  it('does not pass on an empty setting', async () => {
    const given = JSON.parse(await cli({ HTTPS_PROXY: '' }).gh.run(['env-dump'])) as Record<
      string,
      string
    >
    expect(given.HTTPS_PROXY).toBeUndefined()
  })

  it('tells gh never to ask a question, open a browser, check for updates or use colour', async () => {
    const given = JSON.parse(await cli().gh.run(['env-dump'])) as Record<string, string>
    expect(given.GH_PROMPT_DISABLED).toBe('1')
    expect(given.GH_NO_UPDATE_NOTIFIER).toBe('1')
    expect(given.GH_SPINNER_DISABLED).toBe('1')
    expect(given.NO_COLOR).toBe('1')
    expect(given.GH_BROWSER).toBe('')
  })

  it('passes arguments as they are, with no shell to interpret them', async () => {
    const { gh, fake } = cli()
    const nasty = ['api', '; touch pwned', '$(touch pwned2)', '`x`', '| cat', '"quoted"', '*']
    await gh.run(['--version', ...nasty])
    expect(fake.requests()[0]?.args).toEqual(['--version', ...nasty])
  })

  it('sends input on standard input', async () => {
    const { gh, fake } = cli()
    await gh.run(['--version'], { input: '{"a":1}' })
    expect(fake.requests()[0]?.input).toBe('{"a":1}')
  })

  it('is missing when the program named cannot be started', async () => {
    const { gh } = cli(
      {},
      { executable: path.join(tmpdir(), 'no-such-gh-program'), prefixArgs: [] },
    )
    const error = await failure(gh.run(['x']))
    expect(error.code).toBe('missing')
  })

  it('is missing, with where to get it, when there is no gh to find', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'shokuba-gh-'))
    dirs.push(home)
    const gh = new GhCli({ platform: 'linux', env: {}, home, find: async () => null })
    expect(await gh.locate()).toBeNull()
    const error = await failure(gh.run(['x']))
    expect(error.code).toBe('missing')
    expect(error.message).toContain('https://cli.github.com')
  })

  it('looks for gh again after it was missing, so installing it needs no restart', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'shokuba-gh-'))
    dirs.push(home)
    const fake = fakeGh({ login: 'octocat' })
    fakes.push(fake)
    let installed = false
    const gh = new GhCli({
      platform: 'linux',
      env: {},
      home,
      prefixArgs: fake.prefixArgs,
      find: async () => (installed ? fake.executable : null),
    })
    expect((await failure(gh.run(['--version']))).code).toBe('missing')
    installed = true
    expect(await gh.run(['--version'])).toMatch(/^gh version/)
  })

  it('stops a command that takes too long', async () => {
    const error = await failure(cli({}, { timeoutMs: 300 }).gh.run(['sleep']))
    expect(error.code).toBe('timeout')
  })

  it('refuses to read more than the limit, rather than a cut-off answer', async () => {
    const error = await failure(cli({}, { maxBytes: 10_000 }).gh.run(['flood']))
    expect(error.code).toBe('bad-response')
  })

  it('turns a failing exit into an error that says what to do', async () => {
    const error = await failure(cli().gh.run(['exit', '4', 'gh auth login']))
    expect(error.code).toBe('signed-out')
  })

  it('reports an ordinary failure without exposing gh’s own words in the message', async () => {
    const error = await failure(cli().gh.run(['exit', '1', 'gh: something odd']))
    expect(error.code).toBe('failed')
    expect(error.message).not.toContain('odd')
    expect(error.detail).toContain('odd')
  })
})

describe('interpretFailure', () => {
  const code = (exit: number | null, stderr: string, stdout = '') =>
    interpretFailure(exit, stderr, stdout).code

  it('knows when nobody is signed in', () => {
    expect(code(4, '')).toBe('signed-out')
    expect(code(1, 'To get started with GitHub CLI, please run:  gh auth login')).toBe('signed-out')
    expect(code(1, 'You are not logged into any GitHub hosts')).toBe('signed-out')
    expect(code(1, 'gh: Bad credentials (HTTP 401)')).toBe('signed-out')
    expect(code(1, 'gh: Unauthorized (HTTP 401)')).toBe('signed-out')
  })

  it('knows a missing repository or issue', () => {
    expect(code(1, 'gh: Not Found (HTTP 404)')).toBe('not-found')
  })

  it('tells a rate limit from a refusal, though both are HTTP 403', () => {
    expect(code(1, 'gh: API rate limit exceeded for user (HTTP 403)')).toBe('rate-limited')
    expect(code(1, 'gh: You have exceeded a secondary rate limit (HTTP 403)')).toBe('rate-limited')
    expect(code(1, 'gh: Resource not accessible by personal access token (HTTP 403)')).toBe(
      'forbidden',
    )
    expect(code(1, 'gh: Forbidden (HTTP 403)')).toBe('forbidden')
  })

  it('knows when the network is the problem', () => {
    expect(code(1, 'error connecting to api.github.com')).toBe('network')
    expect(
      code(1, 'Get "https://api.github.com/user": dial tcp: lookup api.github.com: no such host'),
    ).toBe('network')
    expect(code(1, 'net/http: TLS handshake timeout')).toBe('network')
  })

  it('is a plain failure for anything else, and its own words are kept only as detail', () => {
    const error = interpretFailure(1, 'gh: something odd happened')
    expect(error.code).toBe('failed')
    expect(error.message).not.toContain('odd')
    expect(error.detail).toContain('odd')
  })

  it('never puts a token in what it keeps', () => {
    const token = ['ghp', '_', 'a'.repeat(36)].join('')
    const error = interpretFailure(1, `gh: failed with ${token}`, `${token}`)
    expect(error.detail).not.toContain(token)
    expect(error.message).not.toContain(token)
  })

  it('reads the error a request prints on standard output too', () => {
    expect(code(1, '', 'gh: Not Found (HTTP 404)')).toBe('not-found')
  })
})
