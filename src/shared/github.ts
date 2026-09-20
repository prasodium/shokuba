import { z } from 'zod'

/**
 * GitHub, as far as the rest of the app needs to know it. Shokuba reaches GitHub only through the
 * `gh` command-line tool the person is already signed in with, and only from the main process, so
 * nothing here is a credential. Everything that comes back from GitHub (an issue's title and text,
 * the names of labels and people) is written by strangers and is treated as untrusted: it is
 * shown as plain text and never followed.
 */

/** A GitHub owner name: letters, digits and single hyphens, up to 39 long. */
export const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
/** A repository name: letters, digits, dot, hyphen and underscore, but never `.` or `..`. */
export const REPO_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/

export interface RepoRef {
  owner: string
  repo: string
}

export function isRepoRef(value: RepoRef): boolean {
  return OWNER_PATTERN.test(value.owner) && REPO_PATTERN.test(value.repo)
}

/** How much of an issue Shokuba keeps. The rest is cut, so a huge issue cannot flood anything. */
export const MAX_ISSUE_TITLE = 200
export const MAX_ISSUE_BODY = 20_000
export const MAX_LABEL = 50

/** Whether Shokuba can use GitHub right now, and if not, what to do about it. */
export type GitHubStatus =
  | { state: 'ready'; login: string }
  /** The `gh` tool is not installed (or not found). */
  | { state: 'missing' }
  /** `gh` is there but is not signed in to github.com. */
  | { state: 'signed-out' }
  | { state: 'error'; message: string }

/** A project (a Git repository an employee works in) that lives on GitHub. */
export interface GitHubProject {
  repoRoot: string
  /** The folder's name, for showing. */
  name: string
  /** `owner/repo`. */
  repo: string
}

export interface IssueSummary {
  number: number
  title: string
  state: 'open' | 'closed'
  author: string | null
  labels: string[]
  comments: number
  updatedAt: string
  url: string
}

/** An issue with its text. The text is untrusted. */
export interface IssueDetail extends IssueSummary {
  body: string
}

/** The mission an issue was made into, and where it came from. */
export interface GitHubLink {
  missionId: string
  /** `owner/repo`. */
  repo: string
  repoRoot: string
  issueNumber: number
  issueTitle: string
  issueUrl: string
  issueAuthor: string | null
  /** The issue's own text as it was when imported. Untrusted. */
  issueBody: string
  importedAt: string
}

export const IssuesRequestSchema = z.strictObject({
  repoRoot: z.string().min(1).max(1024),
  state: z.enum(['open', 'closed', 'all']).default('open'),
})
export type IssuesRequest = z.input<typeof IssuesRequestSchema>

export const IssueImportRequestSchema = z.strictObject({
  repoRoot: z.string().min(1).max(1024),
  number: z.number().int().min(1).max(2_000_000_000),
})
export type IssueImportRequest = z.input<typeof IssueImportRequestSchema>
