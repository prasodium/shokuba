import { describe, expect, it } from 'vitest'
import { parseGitHubRemote } from './remote'

describe('parseGitHubRemote', () => {
  it('reads the usual ways a GitHub repository is written', () => {
    const want = { owner: 'prasodium', repo: 'shokuba' }
    for (const url of [
      'https://github.com/prasodium/shokuba',
      'https://github.com/prasodium/shokuba.git',
      'https://github.com/prasodium/shokuba/',
      'https://github.com/prasodium/shokuba.git/',
      'http://github.com/prasodium/shokuba.git',
      'git@github.com:prasodium/shokuba.git',
      'git@github.com:prasodium/shokuba',
      'ssh://git@github.com/prasodium/shokuba.git',
      'git://github.com/prasodium/shokuba.git',
      '  https://github.com/prasodium/shokuba.git  ',
      'https://GitHub.com/prasodium/shokuba.git',
      'git@GITHUB.COM:prasodium/shokuba.git',
    ]) {
      expect(parseGitHubRemote(url), url).toEqual(want)
    }
  })

  it('ignores credentials in the URL, and never returns them', () => {
    const found = parseGitHubRemote('https://user:secret@github.com/o/r.git')
    expect(found).toEqual({ owner: 'o', repo: 'r' })
    expect(JSON.stringify(found)).not.toContain('secret')
  })

  it('keeps dots, hyphens and underscores in a repository name, and only takes off a final .git', () => {
    expect(parseGitHubRemote('https://github.com/o/my.repo-name_1.git')).toEqual({
      owner: 'o',
      repo: 'my.repo-name_1',
    })
    expect(parseGitHubRemote('https://github.com/o/repo.github.io')).toEqual({
      owner: 'o',
      repo: 'repo.github.io',
    })
  })

  it('is null for any other host, however much it looks like GitHub', () => {
    for (const url of [
      'https://gitlab.com/o/r.git',
      'https://github.com.evil.example/o/r.git',
      'https://evil.example/github.com/o/r.git',
      'https://notgithub.com/o/r',
      'https://api.github.com/o/r',
      'git@gitlab.com:o/r.git',
      'git@github.com.evil.example:o/r.git',
      'https://github.com@evil.example/o/r.git',
      'https://github.example.com/o/r',
    ]) {
      expect(parseGitHubRemote(url), url).toBeNull()
    }
  })

  it('is null for an address longer than any real one', () => {
    expect(parseGitHubRemote(`https://${'u'.repeat(600)}@github.com/o/r.git`)).toBeNull()
    expect(parseGitHubRemote('https://user@github.com/o/r.git')).toEqual({ owner: 'o', repo: 'r' })
  })

  it('is null for a port, another scheme, a local path or nonsense', () => {
    for (const url of [
      'https://github.com:8443/o/r',
      'ftp://github.com/o/r',
      'file:///tmp/o/r',
      '/Users/me/project',
      'C:\\Users\\me\\project',
      '../o/r',
      'o/r',
      '',
      '   ',
      'not a url',
      'x'.repeat(600),
    ]) {
      expect(parseGitHubRemote(url), url).toBeNull()
    }
  })

  it('is null unless the path is exactly an owner and a repository', () => {
    for (const url of [
      'https://github.com/o',
      'https://github.com/',
      'https://github.com/o/r/extra',
      'https://github.com/o/r/tree/main',
      'git@github.com:o',
      'git@github.com:o/r/extra.git',
    ]) {
      expect(parseGitHubRemote(url), url).toBeNull()
    }
  })

  it('is null for names GitHub does not allow, so what comes out is always safe to use in a request', () => {
    for (const url of [
      'https://github.com/-o/r',
      'https://github.com/o-/r',
      'https://github.com/o--x/r',
      'https://github.com/o_x/r',
      `https://github.com/${'o'.repeat(40)}/r`,
      'https://github.com/o/..',
      'https://github.com/o/.',
      'https://github.com/o/r%20x',
      'https://github.com/o/r%2Fx',
      'https://github.com/o/r;rm',
      'https://github.com/o/r$(x)',
      'https://github.com/o/r?x=1',
      'https://github.com/o/r#frag',
      'git@github.com:o/r x.git',
      'git@github.com:o/..',
    ]) {
      expect(parseGitHubRemote(url), url).toBeNull()
    }
  })
})
