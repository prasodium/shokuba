import { z } from 'zod'
import {
  MAX_ISSUE_BODY,
  MAX_ISSUE_TITLE,
  MAX_LABEL,
  isRepoRef,
  type IssueDetail,
  type IssueSummary,
  type RepoRef,
} from '@shared/github'
import { GhError, type GhRunner } from './gh'
import { cleanLine, cleanText } from './text'

/** How many issues one look at a repository shows. */
export const ISSUE_LIMIT = 50
/** How many labels of an issue are kept. */
const MAX_LABELS = 10

const API = ['api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github+json']

/**
 * What is asked of GitHub is cut down by `gh` itself (its `--jq`), before Shokuba reads any of it:
 * only the fields that are used, so a repository full of long issues cannot flood anything, and
 * nothing else in GitHub's reply (URLs to follow, avatars, permissions) is ever looked at. The
 * expressions are fixed text, never built from anything a person or GitHub wrote.
 */
export const LIST_FIELDS =
  '[.[] | select(.pull_request == null) | {number, title, state, user: .user.login, labels: [(.labels // [])[] | .name], comments, updated_at}]'
export const LOGIN_FIELD = '.login // empty'
export const ONE_FIELDS =
  '{number, title, state, user: .user.login, labels: [(.labels // [])[] | .name], comments, updated_at, body, is_pull_request: (.pull_request != null)}'

/** Anything might be missing or the wrong kind: keep what is usable, drop the rest. */
const RawIssue = z.object({
  number: z.number().int().min(1),
  // Zod counts a missing key as an error even for `unknown`, so each is optional on purpose.
  title: z.unknown().optional(),
  state: z.unknown().optional(),
  user: z.unknown().optional(),
  labels: z.unknown().optional(),
  comments: z.unknown().optional(),
  updated_at: z.unknown().optional(),
  body: z.unknown().optional(),
  is_pull_request: z.unknown().optional(),
})

/** The page of an issue on GitHub. Made here from the numbers, never taken from what GitHub sent. */
export function issueUrl(repo: RepoRef, number: number): string {
  return `https://github.com/${repo.owner}/${repo.repo}/issues/${number}`
}

function summarise(repo: RepoRef, raw: z.infer<typeof RawIssue>): IssueSummary | null {
  const state = raw.state === 'open' || raw.state === 'closed' ? raw.state : null
  if (!state) return null
  const title = cleanLine(raw.title, MAX_ISSUE_TITLE)
  const labels = Array.isArray(raw.labels)
    ? raw.labels
        .map((label: unknown) => cleanLine(label, MAX_LABEL))
        .filter((label) => label.length > 0)
        .slice(0, MAX_LABELS)
    : []
  const author = cleanLine(raw.user, 60)
  const updated = typeof raw.updated_at === 'string' ? Date.parse(raw.updated_at) : Number.NaN
  return {
    number: raw.number,
    title: title.length > 0 ? title : `(no title) #${raw.number}`,
    state,
    author: author.length > 0 ? author : null,
    labels,
    comments:
      typeof raw.comments === 'number' && Number.isFinite(raw.comments)
        ? Math.max(0, Math.floor(raw.comments))
        : 0,
    updatedAt: Number.isFinite(updated) ? new Date(updated).toISOString() : '',
    url: issueUrl(repo, raw.number),
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new GhError('bad-response', 'GitHub answered with something Shokuba could not read.')
  }
}

function assertRepo(repo: RepoRef): void {
  // The names go into a request path, so they are checked again here, whoever passed them.
  if (!isRepoRef(repo)) throw new GhError('failed', 'That is not a GitHub repository name.')
}

/**
 * GitHub, read through `gh`. Reads only: it lists and reads issues, and finds out who is signed
 * in. Everything that comes back is written by other people, so it is cut to size, cleaned of
 * characters that hide things, and its links are made here from numbers, not copied.
 */
export class GitHubClient {
  constructor(private readonly gh: GhRunner) {}

  /** Whether `gh` can be run at all. */
  async isInstalled(): Promise<boolean> {
    try {
      await this.gh.run(['--version'])
      return true
    } catch (error) {
      if (error instanceof GhError && error.code === 'missing') return false
      // It ran but did not answer well: it is there.
      return true
    }
  }

  /** The login `gh` is signed in as. Throws `signed-out` if there is none. */
  async login(): Promise<string> {
    const text = await this.gh.run([...API, '--jq', LOGIN_FIELD, 'user'])
    const login = cleanLine(text, 60).replace(/^"|"$/g, '')
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/.test(login)) {
      throw new GhError('bad-response', 'GitHub did not say who is signed in.')
    }
    return login
  }

  async listIssues(repo: RepoRef, state: 'open' | 'closed' | 'all'): Promise<IssueSummary[]> {
    assertRepo(repo)
    const text = await this.gh.run([
      ...API,
      '-X',
      'GET',
      '--jq',
      LIST_FIELDS,
      `repos/${repo.owner}/${repo.repo}/issues`,
      '-f',
      `state=${state}`,
      '-f',
      'sort=updated',
      '-f',
      'direction=desc',
      '-f',
      'per_page=100',
    ])
    const data = parseJson(text)
    if (!Array.isArray(data)) {
      throw new GhError('bad-response', 'GitHub answered with something Shokuba could not read.')
    }
    const issues: IssueSummary[] = []
    for (const item of data) {
      const raw = RawIssue.safeParse(item)
      const issue = raw.success ? summarise(repo, raw.data) : null
      if (issue) issues.push(issue)
      if (issues.length >= ISSUE_LIMIT) break
    }
    return issues
  }

  async getIssue(repo: RepoRef, number: number): Promise<IssueDetail> {
    assertRepo(repo)
    if (!Number.isInteger(number) || number < 1) {
      throw new GhError('failed', 'That is not an issue number.')
    }
    const text = await this.gh.run([
      ...API,
      '-X',
      'GET',
      '--jq',
      ONE_FIELDS,
      `repos/${repo.owner}/${repo.repo}/issues/${number}`,
    ])
    const raw = RawIssue.safeParse(parseJson(text))
    const summary = raw.success ? summarise(repo, raw.data) : null
    if (!raw.success || !summary || raw.data.number !== number) {
      throw new GhError('bad-response', 'GitHub answered with something Shokuba could not read.')
    }
    if (raw.data.is_pull_request === true) {
      throw new GhError(
        'not-found',
        `#${number} is a pull request, not an issue. Shokuba makes missions from issues.`,
      )
    }
    return { ...summary, body: cleanText(raw.data.body, MAX_ISSUE_BODY) }
  }
}
