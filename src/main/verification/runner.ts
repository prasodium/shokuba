import { spawn } from 'node:child_process'
import {
  executeTermination,
  planTerminate,
  safeChildEnv,
  shellCommand,
  type Env,
  type PlatformId,
  type TerminationMode,
} from '../platform'
import { redactString } from '../security/redact'

/** How much of a step's output is kept: the end, where a failure is reported. */
export const MAX_OUTPUT_BYTES = 128 * 1024
const DEFAULT_GRACE_MS = 2_000

export interface StepSpec {
  /** The person's own command line, run through the platform shell. */
  command: string
  /** The folder it runs in. */
  cwd: string
  timeoutMs: number
}

export interface StepOutcome {
  state: 'passed' | 'failed' | 'timeout' | 'error' | 'cancelled'
  exitCode: number | null
  durationMs: number
  /** Cleaned, redacted and cut off at `MAX_OUTPUT_BYTES`. */
  output: string
  truncated: boolean
}

export interface RunnerOptions {
  platform: PlatformId
  /** Shokuba's own environment; only an allow-list of it reaches the command. */
  env: Env
  /** How long a command gets to stop after being asked, before it is killed outright. */
  graceMs?: number
  maxOutputBytes?: number
}

/**
 * Run one command and report how it went. The command is the person's own text, run through the
 * platform shell so `npm test && npm run lint` means what it says; **nothing an agent wrote is
 * ever placed in it**, and the only thing that varies is the folder it runs in.
 *
 * What bounds it:
 *  - a clean environment (an allow-list, so no API keys or credentials from Shokuba's own);
 *  - no input (stdin is closed, so nothing waits for a keypress);
 *  - a time limit, after which the whole process tree is stopped, then killed;
 *  - a cap on the output kept, which is cleaned of terminal control codes and redacted of secrets.
 *
 * It is not a sandbox. It runs whatever the command runs, with the person's access.
 */
export function runStep(
  spec: StepSpec,
  options: RunnerOptions,
  signal?: AbortSignal,
): Promise<StepOutcome> {
  const { platform } = options
  const windows = platform === 'win32'
  const maxBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS
  const started = Date.now()

  return new Promise((resolve) => {
    const env = safeChildEnv(platform, options.env, {
      // Tools take these to mean "no interactive mode, no colour": watch modes and progress bars off.
      CI: 'true',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      TERM: 'dumb',
    })
    const shell = shellCommand(platform, options.env, spec.command)
    // `cmd /s /c "…"` takes the command exactly as written, quotes and all, which is how Node's
    // own shell option runs it; without this Windows would re-quote the person's command.
    const args = windows ? ['/d', '/s', '/c', `"${spec.command}"`] : shell.args

    const chunks: Buffer[] = []
    let kept = 0
    let truncated = false
    const keep = (chunk: Buffer): void => {
      chunks.push(chunk)
      kept += chunk.length
      while (kept > maxBytes && chunks.length > 0) {
        const first = chunks[0] as Buffer
        const excess = kept - maxBytes
        if (first.length <= excess) {
          chunks.shift()
          kept -= first.length
        } else {
          chunks[0] = first.subarray(excess)
          kept -= excess
        }
        truncated = true
      }
    }

    let done = false
    let timedOut = false
    let cancelled = false
    // The two timers are created after the function that clears them, so they live in a holder.
    const timers: { timeout?: NodeJS.Timeout; kill?: NodeJS.Timeout } = {}

    const finish = (state: StepOutcome['state'], exitCode: number | null, extra = ''): void => {
      if (done) return
      done = true
      clearTimeout(timers.timeout)
      clearTimeout(timers.kill)
      signal?.removeEventListener('abort', onAbort)
      // Anything the command left running in its group (a server a test started) goes too.
      if (!windows) stop('force')
      resolve({
        state,
        exitCode,
        durationMs: Date.now() - started,
        output: cleanOutput(Buffer.concat(chunks).toString('utf8') + extra),
        truncated,
      })
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shell.file, args, {
        cwd: spec.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: windows,
        // On POSIX its own process group, so the whole tree can be stopped together.
        detached: !windows,
      })
    } catch (error) {
      resolve({
        state: 'error',
        exitCode: null,
        durationMs: 0,
        output: cleanOutput(`Could not start the command: ${(error as Error).message}`),
        truncated: false,
      })
      return
    }

    const stop = (mode: TerminationMode): void => {
      if (child.pid === undefined) return
      try {
        executeTermination(planTerminate(platform, child.pid, mode))
      } catch {
        // Already gone, which is the outcome wanted.
      }
    }
    const halt = (): void => {
      stop('graceful')
      timers.kill = setTimeout(() => stop('force'), graceMs)
    }
    function onAbort(): void {
      cancelled = true
      halt()
    }

    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.on('error', (error) =>
      finish('error', null, `\nCould not run the command: ${error.message}\n`),
    )
    child.on('close', (code) => {
      if (timedOut) finish('timeout', null)
      else if (cancelled) finish('cancelled', null)
      else finish(code === 0 ? 'passed' : 'failed', code)
    })

    timers.timeout = setTimeout(() => {
      timedOut = true
      halt()
    }, spec.timeoutMs)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Output as text a person can read and the app can show: terminal control sequences removed,
 * progress redraws turned into lines, other control characters dropped, and secrets redacted.
 */
export function cleanOutput(text: string): string {
  const ESC = String.fromCharCode(27)
  const BEL = String.fromCharCode(7)
  let out = text
    // Colours and cursor movement (CSI), and window titles and links (OSC).
    .replace(new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g'), '')
    .replace(new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g'), '')
    .replace(/\r\n?/g, '\n')
  out = [...out]
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code === 0x0a || code === 0x09 || (code >= 0x20 && code !== 0x7f)
    })
    .join('')
  return redactString(out)
}
