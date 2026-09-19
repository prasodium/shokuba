import nodePath from 'node:path'

/**
 * Everything OS-specific lives under src/main/platform. Other modules take a
 * `PlatformId` (defaulting to the real one) instead of reading `process.platform`,
 * so Windows and Linux behaviour is unit-testable from any host.
 */
export type PlatformId = 'darwin' | 'win32' | 'linux'

export type Env = Readonly<Record<string, string | undefined>>

export class UnsupportedPlatformError extends Error {
  constructor(platform: string) {
    super(`Unsupported platform: ${platform}`)
    this.name = 'UnsupportedPlatformError'
  }
}

export function toPlatformId(platform: NodeJS.Platform = process.platform): PlatformId {
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') return platform
  throw new UnsupportedPlatformError(platform)
}

/** The `path` implementation for a platform, regardless of the host we are running on. */
export function pathApi(platform: PlatformId): typeof nodePath.posix {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix
}

/** Look up an environment variable; Windows names are case-insensitive. */
export function getEnv(env: Env, key: string, platform: PlatformId): string | undefined {
  if (platform !== 'win32') return env[key]
  const wanted = key.toLowerCase()
  for (const [name, value] of Object.entries(env)) {
    if (name.toLowerCase() === wanted) return value
  }
  return undefined
}

export interface ShellSpec {
  file: string
  args: readonly string[]
}

/** The interactive shell to use when the user asks for a plain terminal. */
export function defaultShell(platform: PlatformId, env: Env): ShellSpec {
  if (platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] }

  const fromEnv = getEnv(env, 'SHELL', platform)
  const usable = fromEnv && pathApi(platform).isAbsolute(fromEnv) ? fromEnv : undefined
  const fallback = platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
  return { file: usable ?? fallback, args: ['-l'] }
}

/** Run a single command line through the platform's default shell, non-interactively. */
export function shellCommand(platform: PlatformId, env: Env, command: string): ShellSpec {
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    }
  }
  return { file: defaultShell(platform, env).file, args: ['-c', command] }
}

/** sun_path is 104 bytes on macOS/BSD and 108 on Linux, including the trailing NUL. */
const MAX_UNIX_SOCKET_PATH = 103

/**
 * Local IPC endpoint for the agent signal channel (e.g. Claude Code hooks reporting in).
 * Unix domain socket on macOS/Linux, named pipe on Windows — `net.createServer().listen()`
 * accepts either, so callers never branch on platform.
 */
export function ipcEndpoint(platform: PlatformId, name: string, tmpDir: string): string {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, '')
  if (safe.length === 0) throw new Error(`Invalid IPC endpoint name: "${name}"`)

  if (platform === 'win32') return `\\\\.\\pipe\\shokuba-${safe}`

  const socketPath = nodePath.posix.join(tmpDir, `shokuba-${safe}.sock`)
  if (Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH) {
    throw new Error(`Unix socket path is too long (${socketPath.length} chars): ${socketPath}`)
  }
  return socketPath
}
