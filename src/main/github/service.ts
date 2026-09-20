import path from 'node:path'
import type { z } from 'zod'
import {
  IssueImportRequestSchema,
  IssuesRequestSchema,
  type GitHubLink,
  type GitHubProject,
  type GitHubStatus,
  type IssueDetail,
  type IssueImportRequest,
  type IssueSummary,
  type IssuesRequest,
  type RepoRef,
} from '@shared/github'
import type { Db } from '../database/connection'
import type { AuditLog } from '../events/audit'
import type { EventStore } from '../events/store'
import type { MissionService } from '../missions/service'
import type { GitHubClient } from './client'
import { GhError } from './gh'
import { parseGitHubRemote } from './remote'
import { cleanText } from './text'

export class GitHubError extends Error {
  constructor(
    readonly code:
      | 'invalid'
      | 'unknown-project'
      | 'already-imported'
      | 'changed'
      | 'blocked'
      | 'busy'
      | 'pushed',
    message: string,
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

/** Where a folder's Git repository is, and what its `origin` says. */
export interface RepoLocator {
  locate(dir: string): Promise<{ root: string; remoteUrl: string | null } | null>
}

export interface GitHubServiceDeps {
  db: Db
  events: EventStore
  audit: AuditLog
  missions: MissionService
  client: GitHubClient
  repos: RepoLocator
  /** The folders employees work in: the projects. */
  workingDirectories: () => string[]
  now?: () => Date
}

interface LinkRow {
  mission_id: string
  owner: string
  repo: string
  repo_root: string
  issue_number: number
  issue_title: string
  issue_url: string
  issue_author: string | null
  issue_body: string
  imported_at: string
  pr_number: number | null
  pr_draft: number
  pr_opened_at: string | null
}

const toLink = (row: LinkRow): GitHubLink => ({
  missionId: row.mission_id,
  repo: `${row.owner}/${row.repo}`,
  repoRoot: row.repo_root,
  issueNumber: row.issue_number,
  issueTitle: row.issue_title,
  issueUrl: row.issue_url,
  issueAuthor: row.issue_author,
  issueBody: row.issue_body,
  importedAt: row.imported_at,
  pullRequest:
    row.pr_number !== null && row.pr_opened_at !== null
      ? {
          number: row.pr_number,
          url: `https://github.com/${row.owner}/${row.repo}/pull/${row.pr_number}`,
          draft: row.pr_draft === 1,
          openedAt: row.pr_opened_at,
        }
      : null,
})

/**
 * GitHub, for the missions: which of the projects are on GitHub, their issues, and making a mission
 * from one. It only reads from GitHub (through the `gh` the person is signed in with) and only
 * writes to Shokuba's own missions.
 *
 * Which repository is asked about is never taken from the window: it must be one of the projects
 * the employees work in, and its name comes from that project's own `origin` remote.
 */
export class GitHubService {
  private readonly now: () => Date

  constructor(private readonly deps: GitHubServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /** Whether GitHub can be used, and who as, or what to do about it. */
  async status(): Promise<GitHubStatus> {
    try {
      if (!(await this.deps.client.isInstalled())) return { state: 'missing' }
      return { state: 'ready', login: await this.deps.client.login() }
    } catch (error) {
      if (error instanceof GhError) {
        if (error.code === 'missing') return { state: 'missing' }
        if (error.code === 'signed-out') return { state: 'signed-out' }
        return { state: 'error', message: error.message }
      }
      return { state: 'error', message: 'GitHub could not be reached.' }
    }
  }

  /** The projects that are on GitHub: one per repository, in the order they were hired into. */
  async projects(): Promise<GitHubProject[]> {
    const seen = new Set<string>()
    const found: Array<GitHubProject & { ref: RepoRef }> = []
    for (const dir of this.deps.workingDirectories()) {
      const where = await this.deps.repos.locate(dir).catch(() => null)
      if (!where || seen.has(where.root)) continue
      seen.add(where.root)
      const ref = where.remoteUrl ? parseGitHubRemote(where.remoteUrl) : null
      if (!ref) continue
      found.push({
        repoRoot: where.root,
        name: path.basename(where.root),
        repo: `${ref.owner}/${ref.repo}`,
        ref,
      })
    }
    return found.map(({ ref: _ref, ...project }) => project)
  }

  async issues(raw: IssuesRequest): Promise<IssueSummary[]> {
    const request = this.parse(IssuesRequestSchema, raw)
    const project = await this.project(request.repoRoot)
    return this.deps.client.listIssues(project.ref, request.state)
  }

  /** Make a mission from an issue. It is a draft, and the issue's own text is kept apart from it. */
  async importIssue(raw: IssueImportRequest): Promise<GitHubLink> {
    const request = this.parse(IssueImportRequestSchema, raw)
    const project = await this.project(request.repoRoot)
    this.refuseIfImported(project.ref, request.number)

    const issue = await this.deps.client.getIssue(project.ref, request.number)
    const repo = `${project.ref.owner}/${project.ref.repo}`

    const mission = this.deps.missions.createMission(
      {
        title: cleanText(`#${issue.number} ${issue.title}`, 120),
        description: pointer(issue),
      },
      { source: 'user' },
      (created) => {
        // Checked again inside the transaction: a second import that began while this one was
        // reading from GitHub must not make two missions for the same issue.
        this.refuseIfImported(project.ref, issue.number)
        this.deps.db
          .prepare(
            `INSERT INTO github_links
               (mission_id, owner, repo, repo_root, issue_number, issue_title, issue_url,
                issue_author, issue_body, imported_at)
             VALUES (@missionId, @owner, @repo, @repoRoot, @number, @title, @url, @author, @body, @ts)`,
          )
          .run({
            missionId: created.id,
            owner: project.ref.owner,
            repo: project.ref.repo,
            repoRoot: project.repoRoot,
            number: issue.number,
            title: issue.title,
            url: issue.url,
            author: issue.author,
            body: issue.body,
            ts: this.now().toISOString(),
          })
      },
    )

    this.deps.events.publish({
      type: 'github.issue.imported',
      source: 'user',
      missionId: mission.id,
      payload: { missionId: mission.id, repo, number: issue.number },
    })
    this.deps.audit.record({
      actor: 'user',
      action: 'github.issue.import',
      target: mission.id,
      detail: { repo, number: issue.number },
    })
    return this.mustLink(mission.id)
  }

  /** Every mission that came from an issue, and where from. */
  links(): GitHubLink[] {
    const rows = this.deps.db
      .prepare('SELECT * FROM github_links ORDER BY imported_at DESC, mission_id')
      .all() as LinkRow[]
    return rows.map(toLink)
  }

  link(missionId: string): GitHubLink | undefined {
    const row = this.deps.db
      .prepare('SELECT * FROM github_links WHERE mission_id = ?')
      .get(missionId) as LinkRow | undefined
    return row && toLink(row)
  }

  // ---------- inside ----------

  private mustLink(missionId: string): GitHubLink {
    const link = this.link(missionId)
    if (!link) throw new GitHubError('invalid', 'That mission does not come from GitHub')
    return link
  }

  /** The project at `repoRoot`, which must be one of the GitHub projects, never any other folder. */
  private async project(repoRoot: string): Promise<GitHubProject & { ref: RepoRef }> {
    for (const project of await this.projects()) {
      if (project.repoRoot === repoRoot) {
        const ref = parseGitHubRemote(`https://github.com/${project.repo}`)
        if (ref) return { ...project, ref }
      }
    }
    throw new GitHubError('unknown-project', 'That is not one of your projects on GitHub')
  }

  private refuseIfImported(ref: RepoRef, number: number): void {
    const existing = this.deps.db
      .prepare(
        `SELECT l.mission_id AS id FROM github_links l JOIN missions m ON m.id = l.mission_id
         WHERE l.owner = ? AND l.repo = ? AND l.issue_number = ? AND m.archived_at IS NULL`,
      )
      .get(ref.owner, ref.repo, number) as { id: string } | undefined
    if (existing) {
      throw new GitHubError(
        'already-imported',
        `Issue #${number} is already a mission (${this.deps.missions.getMission(existing.id)?.title ?? existing.id})`,
      )
    }
  }

  private parse<T>(schema: z.ZodType<T, unknown>, raw: unknown): T {
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      throw new GitHubError(
        'invalid',
        parsed.error.issues[0]?.message ?? 'That request is not valid',
      )
    }
    return parsed.data
  }
}

/** What goes in a mission's own description: only where it came from, none of the issue's words. */
function pointer(issue: IssueDetail): string {
  return issue.url
}
