import { describe, expect, it } from 'vitest'
import { redactDeep, redactString, scanSecrets } from './redact'

// Secret-shaped fixtures are assembled at runtime so no token-like literal sits in the
// source tree (which would trip secret scanners on a public repository).
const fake = (prefix: string, length: number, char = 'a'): string => prefix + char.repeat(length)

describe('redactString', () => {
  it.each([
    ['anthropic key', fake('sk-' + 'ant-', 30), 'anthropic-key'],
    ['openai-style key', fake('sk' + '-', 40), 'api-key'],
    ['github token', fake('gh' + 'p_', 36), 'github-token'],
    ['github fine-grained token', fake('github' + '_pat_', 40), 'github-token'],
    ['aws access key', 'AKIA' + 'B'.repeat(16), 'aws-access-key'],
    ['slack token', fake('xox' + 'b-', 20, '1'), 'slack-token'],
  ])('redacts a %s', (_name, secret, kind) => {
    const out = redactString(`before ${secret} after`)
    expect(out).toBe(`before [REDACTED:${kind}] after`)
    expect(out).not.toContain(secret)
  })

  it('redacts a JWT', () => {
    const jwt = ['eyJ' + 'h'.repeat(20), 'p'.repeat(20), 's'.repeat(20)].join('.')
    expect(redactString(`token is ${jwt}`)).toBe('token is [REDACTED:jwt]')
  })

  it('redacts a PEM private key block across lines', () => {
    const pem = `-----BEGIN ${'PRIVATE'} KEY-----\nabc\ndef\n-----END ${'PRIVATE'} KEY-----`
    expect(redactString(`key:\n${pem}\ndone`)).toBe('key:\n[REDACTED:private-key]\ndone')
  })

  it('keeps the Bearer scheme but drops the token', () => {
    const token = 'z'.repeat(30)
    const out = redactString(`Authorization: Bearer ${token}`)
    expect(out).toBe('Authorization: Bearer [REDACTED:bearer-token]')
    expect(out).not.toContain(token)
  })

  it('redacts a bare Bearer token outside a header', () => {
    expect(redactString('curl -H "Bearer ' + 'z'.repeat(30) + '"')).toContain(
      '[REDACTED:bearer-token]',
    )
  })

  it('redacts the value, not the key name, when the two are identical', () => {
    expect(redactString('secret=secret')).toBe('secret=[REDACTED:secret-assignment]')
    expect(redactString('password: password')).toBe('password: [REDACTED:secret-assignment]')
  })

  it('redacts the password, not the user, when both are identical', () => {
    expect(redactString('https://bobby:bobby@example.com')).toBe(
      'https://bobby:[REDACTED:url-credentials]@example.com',
    )
  })

  it('drops URL passwords but keeps user and host', () => {
    expect(redactString('git clone https://alice:hunter2pass@example.com/repo.git')).toBe(
      'git clone https://alice:[REDACTED:url-credentials]@example.com/repo.git',
    )
  })

  it('redacts KEY=value assignments but keeps the key name', () => {
    expect(redactString('export API_KEY=abcdef123456')).toBe(
      'export API_KEY=[REDACTED:secret-assignment]',
    )
    expect(redactString('{"password": "hunter2pass"}')).toContain('[REDACTED:secret-assignment]')
  })

  it('leaves ordinary text, git SHAs and short values alone', () => {
    const text = 'commit 3f2a9c1d8b7e6a5f4c3b2a1908d7c6b5a4f3e2d1 fixed the token count'
    expect(redactString(text)).toBe(text)
    expect(redactString('token=abc')).toBe('token=abc') // too short to be a real secret
  })

  it('is idempotent', () => {
    const once = redactString('API_KEY=abcdef123456')
    expect(redactString(once)).toBe(once)
  })
})

describe('redactDeep', () => {
  it('redacts strings nested in objects and arrays without mutating the input', () => {
    const secret = fake('gh' + 'p_', 36)
    const input = { list: [{ note: `use ${secret}` }], n: 3, ok: true, nothing: null }
    const out = redactDeep(input)
    expect(out.list[0]?.note).toBe('use [REDACTED:github-token]')
    expect(out.n).toBe(3)
    expect(out.nothing).toBeNull()
    expect(input.list[0]?.note).toContain(secret) // original untouched
  })

  it('replaces values under sensitive keys whatever they contain', () => {
    const out = redactDeep({
      password: 'x',
      apiKey: 'plain',
      github_token: 'plain',
      Authorization: 'plain',
      username: 'alice',
      empty: '',
    })
    expect(out).toEqual({
      password: '[REDACTED:sensitive-key]',
      apiKey: '[REDACTED:sensitive-key]',
      github_token: '[REDACTED:sensitive-key]',
      Authorization: '[REDACTED:sensitive-key]',
      username: 'alice',
      empty: '',
    })
  })

  it('catches camelCase and prefixed key names, but not look-alikes such as tokenCount', () => {
    const out = redactDeep({
      githubToken: 'plain',
      CLIENT_SECRET: 'plain',
      tokenCount: 'plain',
      maxTokens: 'plain',
    })
    expect(out).toEqual({
      githubToken: '[REDACTED:sensitive-key]',
      CLIENT_SECRET: '[REDACTED:sensitive-key]',
      tokenCount: 'plain',
      maxTokens: 'plain',
    })
  })

  it('keeps non-string values under sensitive keys as they are, so schemas still validate', () => {
    expect(redactDeep({ hasToken: true, token: 5, secret: null })).toEqual({
      hasToken: true,
      token: 5,
      secret: null,
    })
  })

  it('does not overflow the stack on pathological depth', () => {
    let deep: Record<string, unknown> = { leaf: 'x' }
    for (let i = 0; i < 200; i++) deep = { next: deep }
    expect(() => redactDeep(deep)).not.toThrow()
  })
})

describe('scanSecrets', () => {
  it('says what kinds of secret a text holds and how many, and never repeats one', () => {
    const key = fake('sk-' + 'ant-', 30)
    const text = `one ${key}\ntwo ${key}\nAKIA${'B'.repeat(16)}`
    const found = scanSecrets(text)
    expect(found).toEqual([
      { kind: 'anthropic-key', count: 2 },
      { kind: 'aws-access-key', count: 1 },
    ])
    expect(JSON.stringify(found)).not.toContain(key)
  })

  it('finds a secret assigned to a name, and a URL with a password in it', () => {
    const found = scanSecrets(
      `password = "${'x'.repeat(12)}"\nhttps://ren:${'p'.repeat(12)}@example.invalid/`,
    )
    expect(found.map((f) => f.kind).sort()).toEqual(['secret-assignment', 'url-credentials'])
  })

  it('finds nothing in ordinary text, or in text already redacted', () => {
    expect(scanSecrets('const total = add(1, 2)\nreturn total')).toEqual([])
    expect(
      scanSecrets(redactString(`token = ${'y'.repeat(20)} and ${fake('gh' + 'p_', 36)}`)),
    ).toEqual([])
    expect(scanSecrets('')).toEqual([])
  })

  it('can be run again and again with the same answer', () => {
    const text = `key ${fake('sk' + '-', 40)}`
    expect(scanSecrets(text)).toEqual(scanSecrets(text))
  })
})
