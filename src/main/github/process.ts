import { spawn } from 'node:child_process'

export interface ProcessOptions {
  env: Record<string, string>
  cwd: string
  /** Written to the command's standard input, then closed. */
  input?: string
  /** Stop reading after this many bytes of output; the result says it was cut short. */
  maxBytes: number
  timeoutMs: number
}

export interface ProcessResult {
  /** The exit code, or null if it was stopped. */
  code: number | null
  stdout: string
  stderr: string
  /** There was more output than `maxBytes`, and the rest was thrown away. */
  truncated: boolean
  timedOut: boolean
}

/** What to keep of a command's error output: enough to explain, never enough to flood. */
const MAX_STDERR_BYTES = 32 * 1024

/**
 * Run a program with an argument list. Never through a shell, so nothing in an argument can be
 * interpreted as a command. Time and output are bounded. A program that exits with an error is a
 * result, not an exception: the caller decides what the code means. It rejects only when the
 * program cannot be started at all (`error.code` is then `ENOENT`, `EACCES` and so on).
 */
export function runProcess(
  file: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    let truncated = false
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, options.timeoutMs)

    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      action()
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return
      const room = options.maxBytes - outBytes
      if (chunk.length > room) {
        out.push(chunk.subarray(0, Math.max(room, 0)))
        outBytes = options.maxBytes
        truncated = true
        child.kill()
      } else {
        out.push(chunk)
        outBytes += chunk.length
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (errBytes >= MAX_STDERR_BYTES) return
      err.push(chunk.subarray(0, MAX_STDERR_BYTES - errBytes))
      errBytes += chunk.length
    })
    child.on('error', (error) => finish(() => reject(error)))
    child.on('close', (code) =>
      finish(() =>
        resolve({
          code,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          truncated,
          timedOut,
        }),
      ),
    )

    child.stdin.on('error', () => undefined)
    child.stdin.end(options.input ?? '')
  })
}
