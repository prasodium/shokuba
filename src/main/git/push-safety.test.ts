import { describe, expect, it } from 'vitest'
import { configKeys, unsafePushSettings } from './push-safety'

describe('unsafePushSettings', () => {
  it('lets ordinary repository settings through', () => {
    expect(
      unsafePushSettings([
        'core.repositoryformatversion',
        'core.bare',
        'core.filemode',
        'remote.origin.url',
        'remote.origin.fetch',
        'branch.main.remote',
        'branch.main.merge',
        'user.name',
        'user.email',
        'commit.gpgsign',
        'push.default',
        'pull.rebase',
        'init.defaultbranch',
        'alias.st',
        'extensions.worktreeconfig',
      ]),
    ).toEqual([])
  })

  it('refuses settings that make Git run a program', () => {
    expect(
      unsafePushSettings([
        'core.sshcommand',
        'core.askpass',
        'core.gitproxy',
        'credential.helper',
        'credential.https://github.com.helper',
        'gpg.program',
        'gpg.ssh.program',
        'push.gpgsign',
      ]),
    ).toEqual([
      'core.askpass',
      'core.gitproxy',
      'core.sshcommand',
      'credential.*',
      'gpg.program',
      'gpg.ssh.program',
      'push.gpgsign',
    ])
  })

  it('refuses settings that send the push somewhere else', () => {
    expect(
      unsafePushSettings([
        'url.https://evil.example/.insteadof',
        'url.ssh://x/.pushinsteadof',
        'remote.origin.pushurl',
        'remote.fork.receivepack',
        'remote.origin.uploadpack',
        'remote.origin.vcs',
        'remote.origin.proxy',
      ]),
    ).toEqual([
      'remote.*.proxy',
      'remote.*.pushurl',
      'remote.*.receivepack',
      'remote.*.uploadpack',
      'remote.*.vcs',
      'url.*',
    ])
  })

  it('refuses settings that pull in more settings or change the connection', () => {
    expect(
      unsafePushSettings([
        'include.path',
        'includeif.gitdir:/x/.path',
        'http.extraheader',
        'http.https://github.com/.proxy',
        'protocol.ext.allow',
        'ssh.variant',
      ]),
    ).toEqual(['http.*', 'include.path', 'includeIf', 'protocol.*', 'ssh.variant'])
  })

  it('does not care about case', () => {
    expect(
      unsafePushSettings(['Core.SSHCommand', 'URL.a.insteadOf', 'Remote.Origin.PushURL']),
    ).toEqual(['core.sshcommand', 'remote.*.pushurl', 'url.*'])
  })

  it('never repeats a kind', () => {
    expect(
      unsafePushSettings([
        'core.sshcommand',
        'core.sshcommand',
        'url.a.insteadof',
        'url.b.insteadof',
      ]),
    ).toEqual(['core.sshcommand', 'url.*'])
  })

  it('names a setting without the address or name in the middle of it', () => {
    const named = unsafePushSettings([
      'url.https://user:secret@github.com/.insteadof',
      'remote.my-private-remote.pushurl',
      'credential.https://user:secret@example.com.helper',
      'http.https://user:secret@example.com/.extraheader',
    ]).join(' ')
    expect(named).not.toContain('secret')
    expect(named).not.toContain('my-private-remote')
  })
})

describe('configKeys', () => {
  it('reads the keys of a NUL-separated listing, with or without a value', () => {
    const listing =
      'core.bare\nfalse\0user.name\nAda Lovelace\0core.somebool\0remote.origin.url\nhttps://x/y\0'
    expect(configKeys(listing)).toEqual([
      'core.bare',
      'user.name',
      'core.somebool',
      'remote.origin.url',
    ])
  })

  it('keeps a key whose value has a line break in it as one key', () => {
    expect(configKeys('alias.x\n!echo a\necho b\0core.bare\ntrue\0')).toEqual([
      'alias.x',
      'core.bare',
    ])
  })

  it('is empty for an empty listing', () => {
    expect(configKeys('')).toEqual([])
  })
})
