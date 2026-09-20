import type { GitHubLink, GitHubStatus, IssueSummary } from '@shared/github'

/** How the GitHub connection is put to a person: what is true, and what to do about it. */
export interface StatusLine {
  tone: 'good' | 'warn' | 'bad'
  text: string
  /** What to do next, if anything. */
  hint: string | null
}

export function statusLine(status: GitHubStatus | null): StatusLine {
  if (!status) return { tone: 'warn', text: 'Checking GitHub…', hint: null }
  switch (status.state) {
    case 'ready':
      return { tone: 'good', text: `Signed in to GitHub as ${status.login}`, hint: null }
    case 'missing':
      return {
        tone: 'bad',
        text: 'The GitHub command-line tool (gh) is not installed.',
        hint: 'Install it from https://cli.github.com, then run “gh auth login” in a terminal.',
      }
    case 'signed-out':
      return {
        tone: 'bad',
        text: 'GitHub is not signed in on this computer.',
        hint: 'Run “gh auth login” in a terminal, then open this again. Shokuba uses that login and never sees a password or token.',
      }
    case 'error':
      return { tone: 'bad', text: status.message, hint: null }
  }
}

/** The mission an issue was already made into, if it was. */
export function importedAs(
  links: readonly GitHubLink[],
  repo: string,
  number: number,
): GitHubLink | undefined {
  return links.find((link) => link.repo === repo && link.issueNumber === number)
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "5 minutes ago", "3 days ago"… for when an issue was last touched. */
export function whenText(iso: string, now: number): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ''
  const age = now - then
  const count = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'} ago`
  if (age < MINUTE) return 'just now'
  if (age < HOUR) return count(Math.floor(age / MINUTE), 'minute')
  if (age < DAY) return count(Math.floor(age / HOUR), 'hour')
  if (age < 30 * DAY) return count(Math.floor(age / DAY), 'day')
  if (age < 365 * DAY) return count(Math.floor(age / (30 * DAY)), 'month')
  return count(Math.floor(age / (365 * DAY)), 'year')
}

/** The second line of an issue in a list: who, how many comments, when. */
export function issueMeta(issue: IssueSummary, now: number): string {
  const parts: string[] = []
  if (issue.author) parts.push(`by ${issue.author}`)
  if (issue.comments > 0) parts.push(`${issue.comments} comment${issue.comments === 1 ? '' : 's'}`)
  const when = whenText(issue.updatedAt, now)
  if (when) parts.push(`updated ${when}`)
  return parts.join(' · ')
}
