import { createHash } from 'node:crypto'
import type {
  GitHubLink,
  PullOpenRequest,
  PullOpenResult,
  PullPreview,
  PullPreviewRequest,
  RepoRef,
} from '@shared/github'
import { PullOpenRequestSchema, PullPreviewRequestSchema } from '@shared/github'
import type { Db } from '../database/connection'
import type { AuditLog } from '../events/audit'
import type { EventStore } from '../events/store'
import type { EvidencePack } from '../evidence/types'
import type { GitService } from '../git/service'
import { missionBranch } from '../git/refs'
import type { MissionService } from '../missions/service'
import { scanSecrets } from '../security/redact'
import type { GitHubClient } from './client'
import { GhError } from './gh'
import { pullBody, pullTitle, type PullTaskRecord } from './pull-body'
import { isEncryptedRemote, parseGitHubRemote } from './remote'
import { GitHubError } from './service'
import { cleanLine } from './text'
import type { z } from 'zod'

/** How many commits are listed in a preview, and how many bytes of the change are searched for secrets. */
const LISTED_COMMITS = 20
const SCAN_BYTES = 8 * 1024 * 1024
/** The most accepted tasks whose accounts go into the text. */
const MAX_TASKS = 25

export interface PullRequestServiceDeps {
  db: Db
  events: EventStore
  audit: AuditLog
  missions: Pick<MissionService, 'getMission' | 'listMissions'>
  /** The mission's issue link, and so its repository. */
  link: (missionId: string) => GitHubLink | undefined
  /** Git, or undefined when it is not available. */
  git:
    | Pick<
        GitService,
        | 'resolve'
        | 'commits'
        | 'diff'
        | 'commitsAhead'
        | 'remoteUrl'
        | 'remoteTip'
        | 'unsafeSettings'
        | 'push'
      >
    | undefined
  client: Pick<GitHubClient, 'login' | 'defaultBranch' | 'findOpenPull' | 'createPull'>
  evidence: { collect(taskId: string): Promise<EvidencePack> }
  now?: () => Date
}

/** Everything a preview worked out that opening needs and the person does not see. */
interface Plan {
  ref: RepoRef
  repoRoot: string
  /** The full id of the commit that would be pushed. */
  headSha: string
  pushUrl: string
}

/**
 * Opening a pull request for a mission that came from an issue: the one thing in Shokuba that writes
 * to GitHub. It happens in two steps, and only the second changes anything:
 *
 *  1. `preview` works out exactly what would be done (the branch, the commit that would be pushed,
 *     where it would go, the title and text, whether anything is in the way) and writes nothing.
 *     What it shows is covered by a hash.
 *  2. `open`, on the person's click, works the preview out again and refuses if the hash is not the
 *     same, so it can only do what the person was shown. Then it pushes that one commit through the
 *     person's own Git setup and opens the pull request as the person `gh` is signed in as.
 *
 * It never comments on an issue, never merges, never force-pushes, and never pushes anything but one
 * of Shokuba's own mission branches. A change or text that holds something that looks like a secret
 * is never published.
 */
export class PullRequestService {
  private readonly now: () => Date
  private readonly opening = new Set<string>()

  constructor(private readonly deps: PullRequestServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  async preview(raw: PullPreviewRequest): Promise<PullPreview> {
    const request = parse(PullPreviewRequestSchema, raw)
    return (await this.gather(request.missionId)).preview
  }

  async open(raw: PullOpenRequest): Promise<PullOpenResult> {
    const request = parse(PullOpenRequestSchema, raw)
    const { missionId } = request
    if (this.opening.has(missionId)) {
      throw new GitHubError('busy', 'This pull request is already being opened.')
    }
    this.opening.add(missionId)
    try {
      const { preview, plan } = await this.gather(missionId)
      if (preview.hash !== request.hash) {
        throw new GitHubError(
          'changed',
          'Something changed since you looked at this (the work on the branch, GitHub, or the text). Look at it again, and open it if it is still right.',
        )
      }
      const [problem] = preview.problems
      if (problem || !plan) throw new GitHubError('blocked', problem ?? 'It cannot be opened.')

      const { git, client } = this.deps
      if (!git) throw new GitHubError('blocked', 'Git is not available.')
      const outcome = await git.push(plan.repoRoot, plan.pushUrl, preview.branch, plan.headSha)
      this.deps.audit.record({
        actor: 'user',
        action: 'github.pull.push',
        target: missionId,
        detail: { repo: preview.repo, branch: preview.branch, head: preview.head, outcome },
      })

      if (preview.existing) {
        // Only a pull request that was not already recorded (one opened elsewhere) is recorded now.
        const recorded = this.deps.link(missionId)?.pullRequest?.number
        if (recorded !== preview.existing.number) {
          this.record(missionId, preview, preview.existing.number, preview.existing.draft, plan)
        }
        return { ...preview.existing, existing: true }
      }
      try {
        const made = await client.createPull(plan.ref, {
          title: preview.title,
          body: preview.body,
          head: preview.branch,
          base: preview.base,
          draft: request.draft,
        })
        this.record(missionId, preview, made.number, request.draft, plan)
        return { number: made.number, url: made.url, draft: request.draft, existing: false }
      } catch (error) {
        if (error instanceof GhError) {
          throw new GitHubError(
            'pushed',
            `The branch was pushed to GitHub, but the pull request could not be opened: ${error.message}`,
          )
        }
        throw error
      }
    } finally {
      this.opening.delete(missionId)
    }
  }

  // ---------- inside ----------

  private async gather(missionId: string): Promise<{ preview: PullPreview; plan: Plan | null }> {
    const { git, client } = this.deps
    const link = this.deps.link(missionId)
    if (!link) throw new GitHubError('invalid', 'That mission does not come from a GitHub issue')
    const mission = this.deps.missions.getMission(missionId)
    if (!mission) throw new GitHubError('invalid', 'There is no such mission')
    if (!git)
      throw new GitHubError(
        'invalid',
        'Git is not available, so there is no branch to open a pull request from.',
      )
    const ref = parseGitHubRemote(`https://github.com/${link.repo}`)
    if (!ref) throw new GitHubError('invalid', 'That is not a GitHub repository')

    const login = await client.login()
    const branch = missionBranch(missionId)
    const problems: string[] = []
    const warnings: string[] = []
    // The work: what is on the mission branch, and where it started.
    const headSha = await git.resolve(link.repoRoot, branch)
    const baseSha = this.baseOf(missionId, link.repoRoot)
    const ahead = headSha && baseSha ? await git.commitsAhead(link.repoRoot, baseSha, branch) : 0
    if (!headSha || !baseSha || ahead === 0) {
      problems.push(
        'Nothing has been accepted into this mission yet, so there is no work to open a pull request for.',
      )
    }

    const tasks = this.tasksOf(missionId)
    const records = await this.recordsOf(tasks.done)
    const title = pullTitle(link.issueTitle, link.issueNumber)
    const body = pullBody({
      issueNumber: link.issueNumber,
      commitCount: ahead,
      tasks: records,
      tasksNotDone: tasks.notDone,
    })
    if (tasks.notDone > 0) {
      warnings.push(
        `${tasks.notDone} task${tasks.notDone === 1 ? ' is' : 's are'} not done, so ${tasks.notDone === 1 ? 'its' : 'their'} work is not in the branch.`,
      )
    }

    // Where it would go, and what is in the way.
    const pushUrl = await git.remoteUrl(link.repoRoot, 'origin', 'push')
    const pushesTo = pushUrl ? parseGitHubRemote(pushUrl) : null
    if (!pushUrl || !pushesTo || pushesTo.owner !== ref.owner || pushesTo.repo !== ref.repo) {
      problems.push(
        `This project's "origin" no longer points to ${link.repo} on GitHub, so nothing will be pushed.`,
      )
    } else if (!isEncryptedRemote(pushUrl)) {
      problems.push(
        'This project pushes over an unencrypted address (http:// or git://), so Shokuba will not push to it.',
      )
    }
    const unsafe = await git.unsafeSettings(link.repoRoot)
    if (unsafe.length > 0) {
      problems.push(
        `This repository's own Git settings (${unsafe.join(', ')}) run a program or change where a push goes, so Shokuba will not push from it. Move them to your global Git settings, or remove them.`,
      )
    }
    const base = await client.defaultBranch(ref)
    const existing = await client.findOpenPull(ref, branch)
    // One opened for this mission before is followed: new commits are pushed to it while it is open.
    // Once it is closed or merged there is nothing left to push to.
    if (link.pullRequest && existing?.number !== link.pullRequest.number) {
      problems.push(
        `The pull request opened for this mission (#${link.pullRequest.number}) is no longer open on GitHub, so there is nothing to push new commits to.`,
      )
    }
    if (existing) {
      warnings.push(
        `A pull request for this branch is already open (#${existing.number}). Opening will push the new commits to it and will not open a second one.`,
      )
    }

    // What would be published, checked for secrets: the change since GitHub's last known default
    // branch (so work of yours that was only ever local is checked too), or since the mission started.
    const tip = await git.remoteTip(link.repoRoot, 'origin', base)
    let unpublished: number | null = null
    if (tip && baseSha) unpublished = await git.commitsAhead(link.repoRoot, tip, baseSha)
    if (unpublished === null) {
      warnings.push(
        `Shokuba could not tell whether the history this branch is built on is already on GitHub (it has not fetched ${base}). Anything in it that is not will be pushed with the branch.`,
      )
    } else if (unpublished > 0) {
      warnings.push(
        `${unpublished} commit${unpublished === 1 ? '' : 's'} of yours in the history this branch is built on ${unpublished === 1 ? 'is' : 'are'} not on GitHub yet (compared with ${base} as last fetched). ${unpublished === 1 ? 'It' : 'They'} will be pushed with the branch.`,
      )
    }
    if (headSha && baseSha) {
      const diff = await git.diff(link.repoRoot, tip ?? baseSha, headSha, SCAN_BYTES)
      if (diff.truncated) {
        problems.push(
          'The change is too large for Shokuba to check for secrets before it is published.',
        )
      }
      const found = scanSecrets(diff.text)
      if (found.length > 0) {
        problems.push(
          `The change holds something that looks like a secret (${found.map((f) => f.kind).join(', ')}), so it will not be published. Remove it and try again.`,
        )
      }
    }
    const inText = scanSecrets(`${title}\n${body}`)
    if (inText.length > 0) {
      problems.push(
        `The pull request's text holds something that looks like a secret (${inText.map((f) => f.kind).join(', ')}), so it will not be published.`,
      )
    }

    const commits =
      headSha && baseSha
        ? (await git.commits(link.repoRoot, baseSha, headSha, LISTED_COMMITS)).commits
        : []
    const shown: Omit<PullPreview, 'hash'> = {
      missionId,
      repo: link.repo,
      login,
      branch,
      base,
      head: headSha ? headSha.slice(0, 8) : '',
      commits: commits.map((c) => ({
        id: c.commit.slice(0, 8),
        subject: cleanLine(c.subject, 120),
      })),
      commitCount: ahead,
      unpublishedCommits: unpublished,
      tasksNotDone: tasks.notDone,
      title,
      body,
      existing,
      problems,
      warnings,
    }
    // The full commit id is in the hash too, not only the short one shown.
    const hash = createHash('sha256')
      .update(JSON.stringify([shown, headSha]))
      .digest('hex')
    const plan: Plan | null =
      headSha && pushUrl ? { ref, repoRoot: link.repoRoot, headSha, pushUrl } : null
    return { preview: { ...shown, hash }, plan }
  }

  /** The commit the mission's branch was cut from, in full. */
  private baseOf(missionId: string, repoRoot: string): string | null {
    const row = this.deps.db
      .prepare('SELECT base_commit FROM mission_branches WHERE mission_id = ? AND repo_root = ?')
      .get(missionId, repoRoot) as { base_commit: string } | undefined
    return row?.base_commit ?? null
  }

  private tasksOf(missionId: string): {
    done: Array<{ id: string; title: string }>
    notDone: number
  } {
    const detail = this.deps.missions.listMissions().find((d) => d.mission.id === missionId)
    const tasks = detail?.tasks ?? []
    return {
      done: tasks.filter((t) => t.status === 'done').map(({ id, title }) => ({ id, title })),
      notDone: tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled').length,
    }
  }

  /** What each accepted task adds to the text: Shokuba's own sentences, and the agent's own summary. */
  private async recordsOf(done: Array<{ id: string; title: string }>): Promise<PullTaskRecord[]> {
    const records: PullTaskRecord[] = []
    for (const task of done.slice(0, MAX_TASKS)) {
      try {
        const pack = await this.deps.evidence.collect(task.id)
        records.push({
          title: task.title,
          summary: pack.task.agentSummary,
          checks: pack.checks.headline,
          review: pack.reviews.headline,
        })
      } catch {
        records.push({
          title: task.title,
          summary: null,
          checks: 'No record of the checks could be read.',
          review: 'No record of a review could be read.',
        })
      }
    }
    return records
  }

  private record(
    missionId: string,
    preview: PullPreview,
    number: number,
    draft: boolean,
    plan: Plan,
  ): void {
    this.deps.db
      .prepare(
        'UPDATE github_links SET pr_number = @number, pr_draft = @draft, pr_opened_at = @ts, pr_head = @head WHERE mission_id = @id',
      )
      .run({
        id: missionId,
        number,
        draft: draft ? 1 : 0,
        ts: this.now().toISOString(),
        head: plan.headSha,
      })
    this.deps.events.publish({
      type: 'github.pull.opened',
      source: 'user',
      missionId,
      payload: { missionId, repo: preview.repo, number, draft },
    })
    this.deps.audit.record({
      actor: 'user',
      action: 'github.pull.open',
      target: missionId,
      detail: {
        repo: preview.repo,
        number,
        draft,
        head: preview.head,
        existing: preview.existing !== null,
      },
    })
  }
}

function parse<T>(schema: z.ZodType<T, unknown>, raw: unknown): T {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new GitHubError('invalid', parsed.error.issues[0]?.message ?? 'That request is not valid')
  }
  return parsed.data
}
