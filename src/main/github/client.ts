import { z } from 'zod'
import {
  BRANCH_NAME_PATTERN,
  type CheckState,
  type PullCheck,
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
export const DEFAULT_BRANCH_FIELD = '.default_branch // empty'
export const OPEN_PULLS_FIELD = '[.[] | {number, draft: (.draft == true)}]'
export const CREATED_PULL_FIELD = '{number}'
export const PULL_FIELDS =
  '{state, merged: (.merged_at != null), draft: (.draft == true), head: .head.sha}'
export const CHECK_RUNS_FIELDS = '[.check_runs[] | {id, name, status, conclusion}]'
export const STATUSES_FIELDS = '[.statuses[] | {context, state}]'
export const CHECK_RUN_FIELDS = '{name, conclusion, title: .output.title, summary: .output.summary}'
export const REVIEWS_FIELDS = '[.[] | {id, user: .user.login, state, body}]'
export const REVIEW_FIELDS = '{id, user: .user.login, state, body}'
export const REVIEW_COMMENTS_FIELDS = '[.[] | {path, line: (.line // .original_line), body}]'
/** The most of a check's output, a review's text or an inline comment that is kept. */
export const MAX_FEEDBACK = 4_000
export const MAX_REVIEW_COMMENTS = 20
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
/** The most GitHub accepts in a pull request's title and text. */
export const MAX_PULL_TITLE = 256
export const MAX_PULL_BODY = 60_000
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

/** A login as GitHub allows it (an app's login ends in `[bot]`). */
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/

function assertNumber(number: number): void {
  if (!Number.isInteger(number) || number < 1) throw new GhError('failed', 'That is not a number.')
}

function assertRepo(repo: RepoRef): void {
  // The names go into a request path, so they are checked again here, whoever passed them.
  if (!isRepoRef(repo)) throw new GhError('failed', 'That is not a GitHub repository name.')
}

/** How a CI run stands, from the two words GitHub gives it. */
export function runState(status: unknown, conclusion: unknown): CheckState {
  if (status !== 'completed') return 'pending'
  if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped')
    return 'passed'
  const failed = [
    'failure',
    'timed_out',
    'cancelled',
    'action_required',
    'startup_failure',
    'stale',
  ]
  return typeof conclusion === 'string' && failed.includes(conclusion) ? 'failed' : 'pending'
}

/** How a commit status stands. */
export function statusState(state: unknown): CheckState {
  if (state === 'success') return 'passed'
  if (state === 'failure' || state === 'error') return 'failed'
  return 'pending'
}

/** The address of a check's page, made from the repository and its number. */
export function checkUrl(repo: RepoRef, id: number): string {
  return `https://github.com/${repo.owner}/${repo.repo}/runs/${id}`
}

/** The address of a pull request, made from the repository and number. */
export function pullUrl(repo: RepoRef, number: number): string {
  return `https://github.com/${repo.owner}/${repo.repo}/pull/${number}`
}

/**
 * What GitHub said when it would not open a pull request, in words that say what to do. Only a
 * request GitHub understood and refused (a validation failure) is put in other words: a problem
 * with signing in, the network, access or time already says what to do.
 */
function explainPullFailure(error: unknown): unknown {
  if (!(error instanceof GhError) || error.code !== 'failed') return error
  const said = error.detail
  const explain = (message: string): GhError => new GhError(error.code, message, error.detail)
  if (/already exists/i.test(said)) {
    return explain('GitHub says a pull request for this branch already exists.')
  }
  if (/draft pull requests are not supported/i.test(said)) {
    return explain(
      'This repository cannot open draft pull requests. Try again with “Open as a draft” switched off.',
    )
  }
  if (/no commits between/i.test(said)) {
    return explain('GitHub sees no difference between this branch and the one it would go into.')
  }
  return explain('GitHub did not accept the pull request. Its own reason is in the log.')
}

/**
 * GitHub, through `gh`. It reads: who is signed in, a repository's issues and its default branch,
 * and whether a branch already has an open pull request. It writes in exactly one place,
 * `createPull`, which is only ever called for a person's click after they were shown a preview.
 * Everything that comes back is written by other people, so it is cut to size, cleaned of characters
 * that hide things, and its links are made here from numbers, not copied.
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

  /** The branch a pull request would go into by default. */
  async defaultBranch(repo: RepoRef): Promise<string> {
    assertRepo(repo)
    const text = await this.gh.run([
      ...API,
      '-X',
      'GET',
      '--jq',
      DEFAULT_BRANCH_FIELD,
      `repos/${repo.owner}/${repo.repo}`,
    ])
    const name = cleanLine(text, 120)
    if (!BRANCH_NAME_PATTERN.test(name)) {
      throw new GhError('bad-response', 'GitHub did not say which branch is the default.')
    }
    return name
  }

  /** An open pull request for `branch` in this repository, made by anyone, or null. */
  async findOpenPull(
    repo: RepoRef,
    branch: string,
  ): Promise<{ number: number; url: string; draft: boolean } | null> {
    assertRepo(repo)
    if (!BRANCH_NAME_PATTERN.test(branch)) throw new GhError('failed', 'That is not a branch name.')
    const text = await this.gh.run([
      ...API,
      '-X',
      'GET',
      '--jq',
      OPEN_PULLS_FIELD,
      `repos/${repo.owner}/${repo.repo}/pulls`,
      '-f',
      `head=${repo.owner}:${branch}`,
      '-f',
      'state=open',
      '-f',
      'per_page=5',
    ])
    const data = parseJson(text)
    if (!Array.isArray(data)) {
      throw new GhError('bad-response', 'GitHub answered with something Shokuba could not read.')
    }
    for (const item of data) {
      const one = z
        .object({ number: z.number().int().min(1), draft: z.unknown().optional() })
        .safeParse(item)
      if (one.success) {
        return {
          number: one.data.number,
          url: pullUrl(repo, one.data.number),
          draft: one.data.draft === true,
        }
      }
    }
    return null
  }

  /**
   * Open a pull request. This WRITES to GitHub, so it is only ever called for a person's click after
   * they have been shown exactly this. The request goes on standard input, not the command line.
   */
  async createPull(
    repo: RepoRef,
    input: { title: string; body: string; head: string; base: string; draft: boolean },
  ): Promise<{ number: number; url: string }> {
    assertRepo(repo)
    if (!BRANCH_NAME_PATTERN.test(input.head) || !BRANCH_NAME_PATTERN.test(input.base)) {
      throw new GhError('failed', 'That is not a branch name.')
    }
    const title = cleanLine(input.title, MAX_PULL_TITLE)
    if (title.length === 0) throw new GhError('failed', 'A pull request needs a title.')
    let text: string
    try {
      text = await this.gh.run(
        [
          ...API,
          '-X',
          'POST',
          '--jq',
          CREATED_PULL_FIELD,
          `repos/${repo.owner}/${repo.repo}/pulls`,
          '--input',
          '-',
        ],
        {
          input: JSON.stringify({
            title,
            body: cleanText(input.body, MAX_PULL_BODY),
            head: input.head,
            base: input.base,
            draft: input.draft,
          }),
        },
      )
    } catch (error) {
      throw explainPullFailure(error)
    }
    const made = z.object({ number: z.number().int().min(1) }).safeParse(parseJson(text))
    if (!made.success) {
      throw new GhError('bad-response', 'GitHub answered with something Shokuba could not read.')
    }
    return { number: made.data.number, url: pullUrl(repo, made.data.number) }
  }

  /** Where a pull request stands: open, closed, or merged; whether it is a draft; the commit it is at. */
  async getPull(
    repo: RepoRef,
    number: number,
  ): Promise<{ state: 'open' | 'closed' | 'merged'; draft: boolean; head: string }> {
    assertRepo(repo)
    assertNumber(number)
    const text = await this.gh.run([
      ...API,
      '-X',
      'GET',
      '--jq',
      PULL_FIELDS,
      `repos/${repo.owner}/${repo.repo}/pulls/${number}`,
    ])
    const one = z
      .object({
        state: z.enum(['open', 'closed']),
        merged: z.unknown().optional(),
        draft: z.unknown().optional(),
        head: z.string().regex(COMMIT_ID),
      })
      .safeParse(parseJson(text))
    if (!one.success) {
      throw new GhError('bad-response', 'GitHub answered with something Shokuba could not read.')
    }
    return {
      state: one.data.merged === true ? 'merged' : one.data.state,
      draft: one.data.draft === true,
      head: one.data.head,
    }
  }

  /** The checks on a commit: CI runs and commit statuses. Names were written by the repository. */
  async listChecks(repo: RepoRef, commit: string): Promise<PullCheck[]> {
    assertRepo(repo)
    if (!COMMIT_ID.test(commit)) throw new GhError('failed', 'That is not a commit id.')
    const base = `repos/${repo.owner}/${repo.repo}/commits/${commit}`
    const runs = parseJson(
      await this.gh.run([
        ...API,
        '-X',
        'GET',
        '--jq',
        CHECK_RUNS_FIELDS,
        `${base}/check-runs`,
        '-f',
        'per_page=100',
      ]),
    )
    const statuses = parseJson(
      await this.gh.run([
        ...API,
        '-X',
        'GET',
        '--jq',
        STATUSES_FIELDS,
        `${base}/status`,
        '-f',
        'per_page=100',
      ]),
    )
    if (!Array.isArray(runs) || !Array.isArray(statuses)) {
      throw new GhError('bad-response', 'GitHub answered with something Shokuba could not read.')
    }
    const items: PullCheck[] = []
    for (const item of runs) {
      const one = z
        .object({
          id: z.number().int().min(1),
          name: z.unknown().optional(),
          status: z.unknown().optional(),
          conclusion: z.unknown().optional(),
        })
        .safeParse(item)
      if (!one.success) continue
      const name = cleanLine(one.data.name, 120)
      items.push({
        ref: `run:${one.data.id}`,
        name: name.length > 0 ? name : `check ${one.data.id}`,
        state: runState(one.data.status, one.data.conclusion),
        url: checkUrl(repo, one.data.id),
      })
    }
    for (const item of statuses) {
      const one = z
        .object({ context: z.unknown().optional(), state: z.unknown().optional() })
        .safeParse(item)
      if (!one.success) continue
      const name = cleanLine(one.data.context, 120)
      if (name.length === 0) continue
      items.push({ ref: `status:${name}`, name, state: statusState(one.data.state), url: null })
    }
    return items
  }

  /** What one CI run reported, for a task about it. Written by the repository's workflow: untrusted. */
  async checkOutput(
    repo: RepoRef,
    id: number,
  ): Promise<{ name: string; conclusion: string; title: string; summary: string }> {
    assertRepo(repo)
    assertNumber(id)
    const text = await this.gh.run([
      ...API,
      '-X',
      'GET',
      '--jq',
      CHECK_RUN_FIELDS,
      `repos/${repo.owner}/${repo.repo}/check-runs/${id}`,
    ])
    const one = z
      .object({
        name: z.unknown().optional(),
        conclusion: z.unknown().optional(),
        title: z.unknown().optional(),
        summary: z.unknown().optional(),
      })
      .safeParse(parseJson(text))
    if (!one.success) {
      throw new GhError('bad-response', 'GitHub answered with something Shokuba could not read.')
    }
    return {
      name: cleanLine(one.data.name, 120),
      conclusion: cleanLine(one.data.conclusion, 40),
      title: cleanLine(one.data.title, 200),
      summary: cleanText(one.data.summary, MAX_FEEDBACK),
    }
  }

  /** The reviews on a pull request, oldest first. What reviewers wrote is untrusted. */
  async listReviews(
    repo: RepoRef,
    number: number,
  ): Promise<Array<{ id: number; author: string; state: string; body: string }>> {
    assertRepo(repo)
    assertNumber(number)
    const data = parseJson(
      await this.gh.run([
        ...API,
        '-X',
        'GET',
        '--jq',
        REVIEWS_FIELDS,
        `repos/${repo.owner}/${repo.repo}/pulls/${number}/reviews`,
        '-f',
        'per_page=100',
      ]),
    )
    if (!Array.isArray(data)) {
      throw new GhError('bad-response', 'GitHub answered with something Shokuba could not read.')
    }
    const reviews: Array<{ id: number; author: string; state: string; body: string }> = []
    for (const item of data) {
      const one = z
        .object({
          id: z.number().int().min(1),
          user: z.unknown().optional(),
          state: z.unknown().optional(),
          body: z.unknown().optional(),
        })
        .safeParse(item)
      if (!one.success) continue
      const author = cleanLine(one.data.user, 60)
      if (!LOGIN_PATTERN.test(author)) continue
      reviews.push({
        id: one.data.id,
        author,
        state: cleanLine(one.data.state, 30).toUpperCase(),
        body: cleanText(one.data.body, MAX_FEEDBACK),
      })
    }
    return reviews
  }

  /** The inline comments of one review: which file and line, and what was said. Untrusted. */
  async reviewComments(
    repo: RepoRef,
    number: number,
    reviewId: number,
  ): Promise<Array<{ path: string; line: number | null; body: string }>> {
    assertRepo(repo)
    assertNumber(number)
    assertNumber(reviewId)
    const data = parseJson(
      await this.gh.run([
        ...API,
        '-X',
        'GET',
        '--jq',
        REVIEW_COMMENTS_FIELDS,
        `repos/${repo.owner}/${repo.repo}/pulls/${number}/reviews/${reviewId}/comments`,
        '-f',
        'per_page=100',
      ]),
    )
    if (!Array.isArray(data)) {
      throw new GhError('bad-response', 'GitHub answered with something Shokuba could not read.')
    }
    const comments: Array<{ path: string; line: number | null; body: string }> = []
    for (const item of data) {
      const one = z
        .object({
          path: z.unknown().optional(),
          line: z.unknown().optional(),
          body: z.unknown().optional(),
        })
        .safeParse(item)
      if (!one.success) continue
      const body = cleanText(one.data.body, 1_000)
      if (body.length === 0) continue
      comments.push({
        path: cleanLine(one.data.path, 200),
        line:
          typeof one.data.line === 'number' && Number.isInteger(one.data.line) && one.data.line > 0
            ? one.data.line
            : null,
        body,
      })
      if (comments.length >= MAX_REVIEW_COMMENTS) break
    }
    return comments
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
