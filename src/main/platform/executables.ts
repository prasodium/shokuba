import { promises as fs } from 'node:fs'
import { getEnv, pathApi, type Env, type PlatformId } from './platform'

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/** Directories on PATH, in order, without empties or duplicates. */
export function pathDirs(platform: PlatformId, env: Env): string[] {
  const raw = getEnv(env, 'PATH', platform) ?? ''
  const delimiter = platform === 'win32' ? ';' : ':'
  const seen = new Set<string>()
  const dirs: string[] = []
  for (const part of raw.split(delimiter)) {
    const dir = platform === 'win32' ? part.trim().replace(/^"(.*)"$/, '$1') : part
    if (dir.length === 0 || seen.has(dir)) continue
    seen.add(dir)
    dirs.push(dir)
  }
  return dirs
}

/**
 * File names to try for a command. On Windows an extensionless name is not runnable,
 * so we try each PATHEXT extension (and skip the bare name, which is often an npm shim
 * shell-script sitting next to the real `.cmd`).
 */
export function executableCandidates(name: string, platform: PlatformId, env: Env): string[] {
  if (platform !== 'win32') return [name]

  const exts = (getEnv(env, 'PATHEXT', platform) ?? DEFAULT_PATHEXT)
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.length > 0)

  const lower = name.toLowerCase()
  if (exts.some((ext) => lower.endsWith(ext))) return [name]
  return exts.map((ext) => `${name}${ext}`)
}

/**
 * Places CLI tools commonly live that a GUI-launched app may not have on PATH
 * (Finder/Dock launches on macOS get a minimal PATH, so `claude` and `node` are invisible).
 */
export function commonBinDirs(platform: PlatformId, home: string, env: Env): string[] {
  const p = pathApi(platform)
  switch (platform) {
    case 'darwin':
      return [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        p.join(home, '.local', 'bin'),
        p.join(home, '.npm-global', 'bin'),
        p.join(home, '.claude', 'local'),
      ]
    case 'linux':
      return [
        '/usr/local/bin',
        '/usr/bin',
        p.join(home, '.local', 'bin'),
        p.join(home, '.npm-global', 'bin'),
        p.join(home, '.claude', 'local'),
      ]
    case 'win32': {
      const appData = getEnv(env, 'APPDATA', platform) ?? p.join(home, 'AppData', 'Roaming')
      const localAppData = getEnv(env, 'LOCALAPPDATA', platform) ?? p.join(home, 'AppData', 'Local')
      return [
        p.join(appData, 'npm'),
        p.join(localAppData, 'Programs'),
        p.join(home, '.local', 'bin'),
        p.join(home, '.claude', 'local'),
      ]
    }
  }
}

export type ExecutableCheck = (file: string) => Promise<boolean>

/** Default check: a regular file, and on POSIX with an execute bit set. */
export function fileIsExecutable(platform: PlatformId): ExecutableCheck {
  return async (file) => {
    try {
      const stat = await fs.stat(file)
      if (!stat.isFile()) return false
      return platform === 'win32' || (stat.mode & 0o111) !== 0
    } catch {
      return false
    }
  }
}

export interface FindExecutableOptions {
  platform: PlatformId
  env: Env
  home: string
  /** Extra directories searched after PATH and the common bin dirs. */
  extraDirs?: readonly string[]
  isExecutable?: ExecutableCheck
}

/** Resolve a command to an absolute path, or null if it cannot be found. */
export async function findExecutable(
  name: string,
  options: FindExecutableOptions,
): Promise<string | null> {
  const { platform, env, home, extraDirs = [] } = options
  const isExecutable = options.isExecutable ?? fileIsExecutable(platform)
  const p = pathApi(platform)

  const dirs = [...pathDirs(platform, env), ...commonBinDirs(platform, home, env), ...extraDirs]
  const candidates = executableCandidates(name, platform, env)

  const tried = new Set<string>()
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const file = p.join(dir, candidate)
      if (tried.has(file)) continue
      tried.add(file)
      if (await isExecutable(file)) return file
    }
  }
  return null
}
