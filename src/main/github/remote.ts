import { OWNER_PATTERN, REPO_PATTERN, type RepoRef } from '@shared/github'

/**
 * Whether a remote address is one whose traffic is encrypted, so a login is safe to send over it:
 * `https://`, `ssh://`, or the `git@host:path` form (which is SSH). Not `http://`, not `git://`.
 */
export function isEncryptedRemote(url: string): boolean {
  const text = url.trim()
  if (/^(https|ssh):\/\//i.test(text)) return true
  // The SSH shorthand, `user@host:path`, and nothing looser: no scheme, no `::`, no spaces.
  return /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:(?![:/])[A-Za-z0-9._~/-]+$/.test(text)
}

/**
 * The GitHub repository a Git remote URL points at, or null if it is not one. Only github.com
 * counts (Shokuba does not talk to any other host), and the owner and repository names must be
 * ones GitHub allows, so what comes out is safe to put in a request. Credentials in the URL are
 * ignored and never returned.
 *
 * Understood: `https://github.com/o/r`, `https://github.com/o/r.git`, `git@github.com:o/r.git`,
 * `ssh://git@github.com/o/r.git` and `git://github.com/o/r.git`.
 */
export function parseGitHubRemote(url: string): RepoRef | null {
  const text = url.trim()
  if (text.length === 0 || text.length > 500) return null

  let host: string
  let path: string
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(text)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let parsed: URL
    try {
      parsed = new URL(text)
    } catch {
      return null
    }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return null
    // GitHub's own address has no port, query or fragment; anything more is not a plain remote.
    if (parsed.port !== '' || parsed.search !== '' || parsed.hash !== '') return null
    host = parsed.hostname
    path = parsed.pathname
  } else if (scp) {
    host = scp[1] as string
    path = scp[2] as string
  } else {
    return null
  }

  if (host.toLowerCase() !== 'github.com') return null

  const parts = path.replace(/^\/+/, '').replace(/\/+$/, '').split('/')
  if (parts.length !== 2) return null
  const owner = parts[0] as string
  const repo = (parts[1] as string).replace(/\.git$/i, '')
  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo)) return null
  return { owner, repo }
}
