/**
 * What a repository's OWN settings may not contain when Shokuba pushes it. An agent that works in
 * a branch of the repository can, in the worst case, write to the repository's own config, and a
 * few settings there make Git run a program or send the push somewhere else. Your global settings
 * (`git config --global`) are yours and are used as they are; it is only what the repository
 * itself says that is refused, and the person is told which kinds of setting and where to move them.
 *
 *  - programs: `core.sshCommand`, `core.askPass`, `core.gitProxy`, `credential.*` (a helper),
 *    `gpg.*`, `push.gpgSign`
 *  - places: `url.*` (rewrites), `remote.<name>.pushurl|receivepack|uploadpack|vcs|proxy`
 *  - anything that pulls in more settings or changes the connection: `include*`, `http.*`,
 *    `protocol.*`, `ssh.*`
 *
 * Keys are compared as Git prints them (section and variable in lower case).
 */
const UNSAFE: RegExp[] = [
  /^core\.(sshcommand|askpass|gitproxy)$/,
  /^credential\./,
  /^gpg\./,
  /^push\.gpgsign$/,
  /^url\./,
  /^remote\..+\.(pushurl|receivepack|uploadpack|vcs|proxy|proxyauthmethod)$/,
  /^include\./,
  /^includeif\./,
  /^http\./,
  /^protocol\./,
  /^ssh\./,
]

/** The kinds of unsafe setting among `keys`, named without their values or their subsection. */
export function unsafePushSettings(keys: readonly string[]): string[] {
  const found = new Set<string>()
  for (const raw of keys) {
    const key = raw.toLowerCase()
    if (!UNSAFE.some((pattern) => pattern.test(key))) continue
    // `remote.origin.pushurl` -> `remote.*.pushurl`; `url.<base>.insteadof` -> `url.*`; the part in
    // the middle can hold a name or an address, which is no business of a message.
    const parts = key.split('.')
    if (parts[0] === 'remote' && parts.length >= 3) found.add(`remote.*.${parts.at(-1)}`)
    else if (parts[0] === 'url' || parts[0] === 'includeif' || parts[0] === 'credential') {
      found.add(parts[0] === 'includeif' ? 'includeIf' : `${parts[0]}.*`)
    } else if (parts[0] === 'http' || parts[0] === 'protocol') found.add(`${parts[0]}.*`)
    else found.add(key)
  }
  return [...found].sort()
}

/** The keys in the output of `git config --list -z`: each entry is `key`, a newline, then its value. */
export function configKeys(listing: string): string[] {
  return listing
    .split('\0')
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const end = entry.indexOf('\n')
      return end === -1 ? entry : entry.slice(0, end)
    })
}
