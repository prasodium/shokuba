/**
 * The oldest Git Shokuba works with. `merge-tree --write-tree` (2.38) is how a task is merged
 * without touching any checkout, and `--attr-source` (2.40) is how Shokuba's own commands are
 * kept from running filters and merge drivers a repository defines.
 */
export const MIN_GIT: readonly [number, number] = [2, 40]

export interface GitVersion {
  text: string
  major: number
  minor: number
}

/** "git version 2.39.5 (Apple Git-154)", "git version 2.45.1.windows.1", … */
export function parseGitVersion(output: string): GitVersion | null {
  const found = /git version (\d+)\.(\d+)/.exec(output)
  if (!found) return null
  const major = Number(found[1])
  const minor = Number(found[2])
  const full = /git version (\d+(?:\.\d+)*)/.exec(output)
  return { text: full?.[1] ?? `${major}.${minor}`, major, minor }
}

export function isSupported(version: GitVersion): boolean {
  const [minMajor, minMinor] = MIN_GIT
  return version.major > minMajor || (version.major === minMajor && version.minor >= minMinor)
}
