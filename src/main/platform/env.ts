import type { Env, PlatformId } from './platform'

const POSIX_ALLOWED = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TERM',
  'COLORTERM',
  'TMPDIR',
  'TZ',
])

const WINDOWS_ALLOWED = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'USERPROFILE',
  'USERNAME',
  'USERDOMAIN',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'TEMP',
  'TMP',
  'LANG',
  'TERM',
  'COLORTERM',
])

/**
 * Build the environment for a child process from an allow-list.
 *
 * Everything not listed is dropped. That keeps secrets (API keys, cloud credentials,
 * SSH agent sockets) out of agents unless a caller passes them in `extra` on purpose,
 * and it keeps Shokuba's own runtime flags (ELECTRON_RUN_AS_NODE, NODE_OPTIONS, ...)
 * from leaking into terminals — which silently changes how Electron-based tools behave.
 *
 * `extra` wins over inherited values.
 */
export function safeChildEnv(
  platform: PlatformId,
  parent: Env,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const windows = platform === 'win32'
  const allowed = windows ? WINDOWS_ALLOWED : POSIX_ALLOWED
  const out: Record<string, string> = {}

  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue
    const key = windows ? name.toUpperCase() : name
    if (allowed.has(key) || (!windows && name.startsWith('LC_'))) out[name] = value
  }

  for (const [name, value] of Object.entries(extra)) {
    if (windows) {
      // Replace any inherited variable that differs only by case ("Path" vs "PATH").
      for (const existing of Object.keys(out)) {
        if (existing.toLowerCase() === name.toLowerCase()) delete out[existing]
      }
    }
    out[name] = value
  }

  return out
}
