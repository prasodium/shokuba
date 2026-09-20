import type { PullFollowUpResult, PullStatus } from '@shared/github'

/** How long the panel waits between looks at GitHub while it is on screen. */
export const REFRESH_MS = 60_000

/** Whether there is anything left to watch: a pull request that is over does not change. */
export function isWatching(status: Pick<PullStatus, 'state'> | null): boolean {
  return status === null || status.state === 'open'
}

/** What state the pull request is in, in words. */
export function stateLine(status: Pick<PullStatus, 'state' | 'draft'>): string {
  if (status.state === 'merged') return 'Merged'
  if (status.state === 'closed') return 'Closed without being merged'
  return status.draft ? 'Open, as a draft' : 'Open'
}

/** How the checks add up, in words, with counts. */
export function checksLine(checks: PullStatus['checks']): string {
  const count = (state: string): number =>
    checks.items.filter((item) => item.state === state).length
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
  switch (checks.overall) {
    case 'none':
      return 'No checks reported yet'
    case 'passing':
      return `${plural(count('passed'), 'check')} passing`
    case 'pending':
      return `${plural(count('pending'), 'check')} still running, ${count('passed')} passing`
    case 'failing':
      return `${plural(count('failed'), 'check')} failing, ${count('passed')} passing${count('pending') > 0 ? `, ${count('pending')} still running` : ''}`
  }
}

/** What was done when a task was made, and what to do next: nothing runs by itself. */
export function followUpNote(result: Pick<PullFollowUpResult, 'reopened'>): string {
  return result.reopened
    ? 'Made a task. The mission was finished, so it was reopened and is paused: give the task to someone, then press Resume.'
    : 'Made a task. Give it to someone if it is not assigned, and make sure the mission is running.'
}

/** When it was last looked at, as a time of day. */
export function checkedLine(iso: string): string {
  const at = new Date(iso)
  return Number.isNaN(at.getTime())
    ? ''
    : `Looked at GitHub at ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}
