import { pathApi, type PlatformId } from './platform'

/**
 * True when `child` is `parent` itself or lies beneath it.
 *
 * Used for working-directory restrictions, so it must not be fooled by:
 *  - prefix siblings ("/repo-evil" is not inside "/repo")
 *  - ".." escapes
 *  - different drives / UNC roots on Windows
 *  - drive-letter case on Windows ("C:\\Repo" vs "c:\\repo")
 *
 * Both paths must be absolute. Callers should `fs.realpath` them first so symlinks are
 * resolved and on-disk casing is canonical; this function is purely lexical.
 */
export function isPathInside(parent: string, child: string, platform: PlatformId): boolean {
  const p = pathApi(platform)
  if (!p.isAbsolute(parent) || !p.isAbsolute(child)) return false

  const fold = (value: string): string => {
    const resolved = p.resolve(value)
    return platform === 'win32' ? resolved.toLowerCase() : resolved
  }

  const rel = p.relative(fold(parent), fold(child))
  if (rel === '') return true
  if (p.isAbsolute(rel)) return false // different root or drive
  return rel !== '..' && !rel.startsWith(`..${p.sep}`)
}
