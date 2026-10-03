import { describe, expect, it } from 'vitest'
import type { ProviderInfo } from '@shared/ipc/api'
import {
  gitFinding,
  githubFinding,
  loadAbout,
  providerFinding,
  versionPill,
  type AboutSource,
} from './about'

const provider = (extra: Partial<ProviderInfo> = {}, installation = {}): ProviderInfo => ({
  id: 'claude-code',
  displayName: 'Claude Code',
  simulated: false,
  supportsModelSelection: true,
  permissionModes: ['default'],
  installation: {
    found: true,
    path: '/usr/bin/claude',
    version: '2.1.0',
    problem: null,
    ...installation,
  },
  ...extra,
})

describe('the header pill', () => {
  it('names the version and the system, and no phase', () => {
    expect(versionPill({ version: '0.0.1', platform: 'darwin' })).toBe('v0.0.1 · macOS')
    expect(versionPill({ version: '1.2.3', platform: 'win32' })).toBe('v1.2.3 · Windows')
    expect(versionPill({ version: '1.2.3', platform: 'linux' })).toBe('v1.2.3 · Linux')
    expect(versionPill({ version: '0.0.1', platform: 'darwin' })).not.toMatch(/phase/i)
  })
})

describe('what was found on this computer', () => {
  it('Git: the version and the minimum, or why it cannot be used', () => {
    expect(gitFinding({ state: 'ready', version: '2.45.1', minimum: '2.40' })).toEqual({
      label: 'Git',
      text: '2.45.1 (needs 2.40 or newer)',
      ok: true,
    })
    expect(
      gitFinding({ state: 'unavailable', reason: 'Git was not found.', minimum: '2.40' }),
    ).toEqual({ label: 'Git', text: 'Git was not found.', ok: false })
  })

  it('gh: who is signed in, or what to do', () => {
    expect(githubFinding({ state: 'ready', login: 'octocat' })).toMatchObject({
      text: 'Signed in as octocat',
      ok: true,
    })
    expect(githubFinding({ state: 'signed-out' })).toMatchObject({ ok: false })
    expect(githubFinding({ state: 'signed-out' }).text).toContain('gh auth login')
    expect(githubFinding({ state: 'missing' })).toMatchObject({ text: 'Not found', ok: false })
    expect(githubFinding({ state: 'error', message: 'boom' })).toMatchObject({
      text: 'boom',
      ok: false,
    })
  })

  it('a provider: its version, its problem, or that it is simulated', () => {
    expect(providerFinding(provider())).toEqual({ label: 'Claude Code', text: '2.1.0', ok: true })
    expect(providerFinding(provider({}, { version: null }))).toMatchObject({
      text: 'Found, version unknown',
      ok: true,
    })
    expect(
      providerFinding(
        provider({}, { found: false, path: null, version: null, problem: 'Not installed' }),
      ),
    ).toMatchObject({ text: 'Not installed', ok: false })
    expect(providerFinding(provider({}, { found: false, version: null }))).toMatchObject({
      text: 'Not found',
      ok: false,
    })
    // Found, but it cannot be launched (for example a shim that needs cmd.exe).
    expect(providerFinding(provider({}, { problem: 'Needs cmd.exe' }))).toMatchObject({
      text: 'Needs cmd.exe',
      ok: false,
    })
    expect(
      providerFinding(provider({ displayName: 'Demo agent', simulated: true }, { version: null })),
    ).toMatchObject({ text: 'Built in, needs no AI account', ok: true })
  })
})

describe('loading the About facts', () => {
  const source = (extra: Partial<AboutSource> = {}): AboutSource => ({
    git: async () => ({ state: 'ready', version: '2.45.1', minimum: '2.40' }),
    github: async () => ({ state: 'missing' }),
    providers: async () => [provider()],
    ...extra,
  })

  it('reads all three', async () => {
    const facts = await loadAbout(source())
    expect(facts.git).toEqual({
      ok: true,
      value: { state: 'ready', version: '2.45.1', minimum: '2.40' },
    })
    expect(facts.github).toEqual({ ok: true, value: { state: 'missing' } })
    expect(facts.providers).toEqual({ ok: true, value: [provider()] })
  })

  it('keeps the rest when one fails, and drops the wrapper Electron adds', async () => {
    const facts = await loadAbout(
      source({
        github: () =>
          Promise.reject(
            new Error("Error invoking remote method 'shokuba:github:status': Error: boom"),
          ),
      }),
    )
    expect(facts.github).toEqual({ ok: false, error: 'boom' })
    expect(facts.git.ok).toBe(true)
    expect(facts.providers.ok).toBe(true)
  })
})
