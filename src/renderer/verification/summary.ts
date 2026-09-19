import type { CheckResult, CheckRun, StepState, TaskVerification } from '@shared/verification'

export const STEP_LABELS: Record<StepState, string> = {
  passed: 'Passed',
  failed: 'Failed',
  timeout: 'Timed out',
  skipped: 'Not run',
  error: 'Could not run',
  cancelled: 'Cancelled',
}

/** How long a step took, as a person would say it. */
export function durationText(ms: number): string {
  if (ms < 1_000) return '<1s'
  const seconds = Math.round(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
}

/** The checks (not the setup) in a run: what is actually being judged. */
const judged = (run: CheckRun): CheckResult[] => run.results.filter((r) => r.kind === 'check')

/** One line on how a run went. */
export function runHeadline(run: CheckRun): string {
  switch (run.state) {
    case 'running':
      return 'Checks are running…'
    case 'cancelled':
      return 'Checks were cancelled because the work changed'
    case 'error':
      return run.note ?? 'The checks could not be run'
    case 'passed': {
      const checks = judged(run)
      return `Checks passed (${checks.length} of ${checks.length})`
    }
    case 'failed': {
      if (run.note) return run.note
      const checks = judged(run)
      const bad = checks.filter((r) => r.state !== 'passed')
      const names = bad.map((r) => r.name).join(', ')
      return `${bad.length} of ${checks.length} checks did not pass: ${names}`
    }
  }
}

/** Which way a run points, for colouring: good, bad, in between. */
export function runTone(run: CheckRun): 'good' | 'bad' | 'neutral' {
  if (run.state === 'passed') return 'good'
  if (run.state === 'failed' || run.state === 'error') return 'bad'
  return 'neutral'
}

/**
 * What gives pause before a person accepts work whose checks did not pass, or null if there is
 * nothing. It only ever informs and never blocks: the person decides, and checks can be wrong
 * (a flaky test, a missing dependency) as easily as the work.
 */
export function acceptConcern(verification: TaskVerification): string | null {
  const run = verification.latest
  if (!run) return null
  if (run.state === 'failed') return `${runHeadline(run)}.`
  if (run.state === 'error') return `${runHeadline(run)}, so this work has not been checked.`
  return null
}

/**
 * The one question put to the person before accepting, made from whatever gave them pause (the
 * checks, a reviewer), or null when nothing did. Accepting is never blocked, only asked about.
 */
export function acceptQuestion(concerns: ReadonlyArray<string | null>): string | null {
  const present = concerns.filter((concern): concern is string => concern !== null)
  return present.length === 0 ? null : `${present.join('\n\n')}\n\nAccept the work anyway?`
}

/** Whether the checks can be run again by hand right now. */
export function canRunAgain(verification: TaskVerification, status: string): boolean {
  if (!verification.configured || verification.latest?.state === 'running') return false
  return status === 'submitted' || status === 'changes_requested' || status === 'blocked'
}
