import { spawn } from 'node:child_process'

export type GitErrorCode =
  | 'not-a-repo'
  | 'no-commits'
  | 'unsupported'
  | 'unsafe'
  | 'exists'
  | 'checked-out'
  | 'timeout'
  | 'failed'

/** A Git problem with a message a person can read. `detail` is Git's own output, for the log. */
export class GitError extends Error {
  constructor(
    readonly code: GitErrorCode,
    message: string,
    readonly detail: string = '',
  ) {
    super(message)
    this.name = 'GitError'
  }
}

export interface RunOptions {
  cwd: string
  /** Written to the command's standard input. */
  input?: string
  /** Stop reading after this many bytes of output; the result says it was cut short. */
  maxBytes?: number
  timeoutMs?: number
  /** Exit codes that are an answer, not a failure (for example 1 from `merge-tree`). */
  okCodes?: readonly number[]
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
  truncated: boolean
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Run Git with an argument list. Never through a shell, so nothing in an argument can be
 * interpreted as a command. Output and time are bounded.
 */
export function runGit(
  executable: string,
  args: readonly string[],
  env: Record<string, string>,
  options: RunOptions,
): Promise<RunResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const okCodes = options.okCodes ?? [0]

  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outBytes = 0
    let truncated = false
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      action()
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return
      const room = maxBytes - outBytes
      if (chunk.length > room) {
        out.push(chunk.subarray(0, Math.max(room, 0)))
        outBytes = maxBytes
        truncated = true
        child.kill()
      } else {
        out.push(chunk)
        outBytes += chunk.length
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (err.reduce((n, c) => n + c.length, 0) < 64 * 1024) err.push(chunk)
    })
    child.on('error', (error) =>
      finish(() => reject(new GitError('failed', `Could not run Git: ${error.message}`))),
    )
    child.on('close', (code) =>
      finish(() => {
        const stdout = Buffer.concat(out).toString('utf8')
        const stderr = Buffer.concat(err).toString('utf8')
        if (timedOut) {
          reject(
            new GitError('timeout', `Git took longer than ${timeoutMs / 1000}s and was stopped`),
          )
        } else if (truncated) {
          resolve({ code: 0, stdout, stderr, truncated })
        } else if (code !== null && okCodes.includes(code)) {
          resolve({ code, stdout, stderr, truncated })
        } else {
          reject(
            new GitError(
              'failed',
              firstLine(stderr) || `Git exited with code ${code ?? 'unknown'}`,
              `git ${args.slice(0, 4).join(' ')} …: ${stderr.trim().slice(0, 2000)}`,
            ),
          )
        }
      }),
    )

    child.stdin.on('error', () => undefined)
    child.stdin.end(options.input ?? '')
  })
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]?.slice(0, 300) ?? ''
}
