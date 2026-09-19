import { execFile } from 'node:child_process'
import type { PlatformId } from './platform'

/**
 * Ctrl+C. Interrupting an agent is done by writing this to its PTY on every platform:
 * ConPTY on Windows cannot be signalled the way a POSIX process group can.
 */
export const INTERRUPT_SEQUENCE = '\x03'

export type TerminationMode = 'graceful' | 'force'

export type TerminationPlan =
  /** POSIX: signal the whole process group with `process.kill(-pid, signal)`. */
  | { kind: 'signal-group'; pid: number; signal: 'SIGTERM' | 'SIGKILL' }
  /** Windows: there are no process groups; `taskkill /T` walks the child tree. */
  | { kind: 'taskkill'; command: 'taskkill'; args: string[] }

/**
 * Describe how to stop an agent *and everything it spawned*. Pure, so it can be tested
 * on any host; the agent runtime executes the plan.
 *
 * On POSIX this relies on node-pty starting each child as a session leader, which makes
 * its process-group id equal its pid.
 */
export function planTerminate(
  platform: PlatformId,
  pid: number,
  mode: TerminationMode,
): TerminationPlan {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`Refusing to terminate pid ${pid}`)

  if (platform === 'win32') {
    return {
      kind: 'taskkill',
      command: 'taskkill',
      args: ['/pid', String(pid), '/T', ...(mode === 'force' ? ['/F'] : [])],
    }
  }
  return { kind: 'signal-group', pid, signal: mode === 'force' ? 'SIGKILL' : 'SIGTERM' }
}

/**
 * Carry out a termination plan. A process group that is already gone is the outcome that was
 * wanted, so that is not an error; on Windows `taskkill` is fire-and-forget.
 */
export function executeTermination(plan: TerminationPlan): void {
  if (plan.kind === 'signal-group') {
    try {
      process.kill(-plan.pid, plan.signal)
    } catch (error) {
      // ESRCH: the group is already gone.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    return
  }
  execFile(plan.command, plan.args, { windowsHide: true }, () => undefined)
}
