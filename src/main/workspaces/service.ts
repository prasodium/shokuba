import { promises as fs } from 'node:fs'
import type { FileChange, MissionBranchInfo, TaskChanges } from '@shared/git'
import type { Task } from '@shared/missions'
import type { Db } from '../database/connection'
import type { EventStore } from '../events/store'
import { GitError } from '../git/runner'
import { missionBranch, taskBranch } from '../git/refs'
import type { GitService } from '../git/service'
import { describeError, type Logger } from '../logging/logger'
import { pathApi, type PlatformId } from '../platform'

export interface WorkspaceEmployee {
  id: string
  name: string
  workingDirectory: string
}

/** What the dispatcher needs to hand a task over: where the agent works, and what to tell it. */
export interface PreparedWorkspace {
  cwd: string
  note: string
}

/** The result of accepting a task's work into its mission branch. */
export type AcceptMerge =
  | { kind: 'not-isolated' }
  | { kind: 'merged' | 'up-to-date' }
  | { kind: 'conflict'; files: string[]; missionBranch: string }

export interface WorkspaceServiceDeps {
  db: Db
  events: EventStore
  missions: {
    getTask(id: string): Task | undefined
    getMission(id: string): { id: string } | undefined
  }
  employees: { get(id: string): WorkspaceEmployee | undefined }
  /** Git, or undefined when it cannot be used, with `unavailable` saying why. */
  git: GitService | undefined
  unavailable?: string
  platform: PlatformId
  logger: Logger
  now?: () => Date
}

interface Row {
  task_id: string
  mission_id: string
  state: 'active' | 'merged' | 'none' | 'removed'
  repo_root: string | null
  branch: string | null
  worktree_path: string | null
  base_commit: string | null
  head_commit: string | null
  merge_commit: string | null
  note: string | null
  removed_at: string | null
}

/** Enough of a Git repository is left over after a failure to be worth cleaning up. */
const TEXT_LIMIT = 300

/**
 * Where a task's work happens. When the assignee's folder is in a Git repository the task gets
 * its own branch and working folder (cut from the mission's branch, so it starts from the work
 * already accepted), and accepting it merges that branch back. When it cannot be isolated (no
 * Git, not a repository, no commits yet) the task runs as it always has and the record says
 * why, so nothing that worked before stops working and the person is told plainly.
 *
 * It never fails a task over Git: every problem here becomes "not isolated" or a note.
 */
export class WorkspaceService {
  private readonly now: () => Date

  constructor(private readonly deps: WorkspaceServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  // ---------- handing a task over ----------

  /**
   * Get the task's isolated working folder, making it the first time. Returns null when the task
   * runs without isolation. Safe to call again for the same task: it reuses the folder.
   */
  async prepare(task: Task): Promise<PreparedWorkspace | null> {
    const existing = this.row(task.id)
    if (existing?.state === 'active') {
      const reused = await this.reuse(existing, task)
      if (reused) return reused
    }
    return this.create(task)
  }

  private async reuse(row: Row, task: Task): Promise<PreparedWorkspace | null> {
    const { git } = this.deps
    if (!git || !row.repo_root || !row.worktree_path || !row.branch) return null
    try {
      if (!(await exists(row.worktree_path))) {
        await git.reattachWorktree(row.repo_root, row.worktree_path, row.branch)
        this.update(task.id, { removed_at: null })
      }
      return await this.describe(row.repo_root, row.worktree_path, row.branch, task)
    } catch (error) {
      this.deps.logger.warn('workspace.reuse.failed', { taskId: task.id, ...describeError(error) })
      return null
    }
  }

  /** The assignee's own folder, as a real path: where their agent belongs when a task is not isolated. */
  async home(task: Task): Promise<string | undefined> {
    const directory = this.deps.employees.get(task.assigneeId ?? '')?.workingDirectory
    if (!directory) return undefined
    try {
      return await fs.realpath(directory)
    } catch {
      return undefined
    }
  }

  private async create(task: Task): Promise<PreparedWorkspace | null> {
    const { git } = this.deps
    if (!git) return this.notIsolated(task, this.deps.unavailable ?? 'Git is not available')
    const employee = task.assigneeId ? this.deps.employees.get(task.assigneeId) : undefined
    if (!employee) return this.notIsolated(task, 'the task has no assignee')

    let folder: { root: string; dir: string } | undefined
    try {
      const root = await git.repoRoot(employee.workingDirectory)
      const head = await git.head(root)
      const mission = await this.missionBranchFor(git, root, task.missionId, head.commit)
      const base = await git.resolve(root, mission)
      if (!base) throw new GitError('failed', 'The mission branch is missing')

      const dir = git.worktreePath(root, task.id)
      const branch = taskBranch(task.id)
      if (await exists(dir)) await git.removeWorktree(root, dir) // a leftover from an earlier attempt
      await git.createWorktree(root, dir, branch, mission)
      folder = { root, dir }

      this.upsert(task, {
        state: 'active',
        repo_root: root,
        branch,
        worktree_path: dir,
        base_commit: base,
        head_commit: base,
        merge_commit: null,
        note: null,
        removed_at: null,
      })
      this.publish(task, { change: 'created', branch })
      return await this.describe(root, dir, branch, task, employee.workingDirectory)
    } catch (error) {
      this.deps.logger.warn('workspace.create.failed', { taskId: task.id, ...describeError(error) })
      if (folder) await this.discard(folder.root, folder.dir)
      return this.notIsolated(task, reasonOf(error))
    }
  }

  /** Where inside the working folder the agent should start, and what to tell it. */
  private async describe(
    root: string,
    dir: string,
    branch: string,
    task: Task,
    employeeDirectory?: string,
  ): Promise<PreparedWorkspace> {
    const paths = pathApi(this.deps.platform)
    const directory =
      employeeDirectory ?? this.deps.employees.get(task.assigneeId ?? '')?.workingDirectory
    let cwd = dir
    if (directory) {
      try {
        // An employee working in a subfolder of the repository keeps working in that subfolder.
        const relative = paths.relative(root, await fs.realpath(directory))
        if (relative && !relative.startsWith('..') && !paths.isAbsolute(relative)) {
          const inside = paths.join(dir, relative)
          if (await exists(inside)) cwd = inside
        }
      } catch {
        // The folder is not there any more; the top of the working folder is fine.
      }
    }
    // A real path, so it compares equal to where the agent process reports it is working.
    cwd = await fs.realpath(cwd)
    return {
      cwd,
      note:
        `This task is isolated in its own Git branch (${branch}), and your working folder is ${cwd}. ` +
        'Work only there. Shokuba saves your changes as a commit when you submit, so you do not need to commit, ' +
        'and please do not switch branches. It starts from the last commit of the project: changes that were not ' +
        'yet committed in the main checkout are not in it.',
    }
  }

  private async missionBranchFor(
    git: GitService,
    root: string,
    missionId: string,
    headCommit: string,
  ): Promise<string> {
    const branch = missionBranch(missionId)
    const known = this.deps.db
      .prepare('SELECT base_commit FROM mission_branches WHERE mission_id = ? AND repo_root = ?')
      .get(missionId, root) as { base_commit: string } | undefined
    // Made once from the project's current commit; later tasks find it where accepted work has left it.
    await git.ensureBranch(root, branch, known?.base_commit ?? headCommit)
    if (!known) {
      this.deps.db
        .prepare(
          'INSERT INTO mission_branches (mission_id, repo_root, branch, base_commit, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(missionId, root, branch, headCommit, this.stamp())
    }
    return branch
  }

  // ---------- when the agent submits ----------

  /**
   * Save the agent's work as a commit. Never throws: a task is not lost over Git. Returns whether
   * the work is safe on the branch (which includes there being nothing to save); false means it
   * could not be saved, and the folder must not be touched.
   */
  async commit(task: Task): Promise<boolean> {
    const { git } = this.deps
    const row = this.row(task.id)
    if (
      !git ||
      !row ||
      row.state !== 'active' ||
      !row.repo_root ||
      !row.worktree_path ||
      !row.branch
    ) {
      return true // nothing of Shokuba's to save
    }
    try {
      const author = this.deps.employees.get(task.assigneeId ?? '')?.name ?? 'Shokuba'
      const made = await git.commitAll(
        row.repo_root,
        row.worktree_path,
        `Task: ${task.title}`,
        author,
      )
      const head = made ?? (await git.resolve(row.repo_root, row.branch)) ?? row.head_commit
      this.update(task.id, { head_commit: head, note: null })
      if (made) this.publish(task, { change: 'committed', branch: row.branch, commit: made })
      return true
    } catch (error) {
      this.deps.logger.warn('workspace.commit.failed', { taskId: task.id, ...describeError(error) })
      this.update(task.id, {
        note: `Shokuba could not save the agent's work as a commit: ${reasonOf(error)}`,
      })
      return false
    }
  }

  // ---------- reviewing and accepting ----------

  /** What the task changed, for the person reviewing it. */
  async changes(taskId: string): Promise<TaskChanges> {
    const { git } = this.deps
    const row = this.row(taskId)
    if (!row) return { isolated: false, reason: null }
    if (row.state === 'none') return { isolated: false, reason: row.note }
    if (!git || !row.repo_root || !row.branch) {
      return { isolated: false, reason: this.deps.unavailable ?? 'Git is not available' }
    }
    if (row.state === 'removed') {
      return { isolated: false, reason: 'its working folder has been removed' }
    }
    try {
      const mission = missionBranch(row.mission_id)
      // A merged task is compared with where it started; one still open, with the mission branch as it is now.
      const base =
        row.state === 'active' && (await git.resolve(row.repo_root, mission))
          ? mission
          : (row.base_commit ?? mission)
      const files: FileChange[] = await git.changedFiles(row.repo_root, base, row.branch)
      const { text, truncated } = await git.diff(row.repo_root, base, row.branch)
      return {
        isolated: true,
        branch: row.branch,
        state: row.state === 'merged' ? 'merged' : 'active',
        files,
        folderRemoved: row.removed_at !== null,
        diff: text,
        truncated,
        note: row.note,
      }
    } catch (error) {
      this.deps.logger.warn('workspace.changes.failed', { taskId, ...describeError(error) })
      return { isolated: false, reason: `the changes could not be read: ${reasonOf(error)}` }
    }
  }

  /**
   * Merge an accepted task into its mission branch. A conflict changes nothing and names the
   * files, so the task can go back to the agent to resolve.
   */
  async mergeForAccept(task: Task): Promise<AcceptMerge> {
    const { git } = this.deps
    const row = this.row(task.id)
    if (!git || !row || row.state !== 'active' || !row.repo_root || !row.branch) {
      return { kind: 'not-isolated' }
    }
    // The agent may have touched files after it submitted.
    await this.commit(task)
    const mission = missionBranch(row.mission_id)
    const outcome = await git.merge(
      row.repo_root,
      mission,
      row.branch,
      `Accept: ${task.title}`,
      'Shokuba',
    )
    if (outcome.kind === 'conflict') {
      this.publish(task, {
        change: 'conflict',
        branch: row.branch,
        files: outcome.files.slice(0, 50),
      })
      return { kind: 'conflict', files: outcome.files, missionBranch: mission }
    }
    this.update(task.id, {
      state: 'merged',
      merge_commit: outcome.kind === 'merged' ? outcome.commit : null,
    })
    this.publish(task, {
      change: 'merged',
      branch: mission,
      ...(outcome.kind === 'merged' && { commit: outcome.commit }),
    })
    return { kind: outcome.kind }
  }

  // ---------- for verification ----------

  /** Where a task's work is, if it has a working folder that still exists on record. */
  infoFor(taskId: string): { repoRoot: string; folder: string; branch: string } | undefined {
    const row = this.row(taskId)
    if (!row || row.state !== 'active' || row.removed_at !== null) return undefined
    if (!row.repo_root || !row.worktree_path || !row.branch) return undefined
    return { repoRoot: row.repo_root, folder: row.worktree_path, branch: row.branch }
  }

  /**
   * The commit a task's work is compared against for review: the mission branch as it is now
   * (so the review shows only this task's own change), or where the task started.
   */
  async reviewBase(taskId: string): Promise<string | undefined> {
    const { git } = this.deps
    const row = this.row(taskId)
    if (!git || !row?.repo_root || !row.branch) return undefined
    const mission =
      row.state === 'active'
        ? await git.resolve(row.repo_root, missionBranch(row.mission_id))
        : null
    return mission ?? row.base_commit ?? undefined
  }

  /** Why a task that was handed out has no working folder of its own, if that is so. */
  isolationReason(taskId: string): string | null {
    const row = this.row(taskId)
    return row?.state === 'none' ? row.note : null
  }

  /** Every repository Shokuba has made a mission branch or a working folder in. */
  knownRepos(): string[] {
    const rows = this.deps.db
      .prepare(
        `SELECT repo_root FROM mission_branches
         UNION SELECT repo_root FROM task_workspaces WHERE repo_root IS NOT NULL
         ORDER BY repo_root`,
      )
      .all() as Array<{ repo_root: string }>
    return rows.map((row) => row.repo_root)
  }

  // ---------- cleaning up ----------

  /**
   * Tasks whose working folder is due to be removed: the task is finished, its work is safe on
   * a branch (merged into the mission, or cancelled and so kept where it is), and the folder is
   * still there. A finished task whose work was never merged is left alone, not guessed at.
   */
  pendingRemoval(): Array<{ task: Task; folder: string }> {
    const rows = this.deps.db
      .prepare(
        "SELECT * FROM task_workspaces WHERE removed_at IS NULL AND worktree_path IS NOT NULL AND state IN ('active', 'merged')",
      )
      .all() as Row[]
    const due: Array<{ task: Task; folder: string }> = []
    for (const row of rows) {
      const task = this.deps.missions.getTask(row.task_id)
      if (!task || !row.worktree_path) continue
      const finished = task.status === 'done' || task.status === 'cancelled'
      const safe = row.state === 'merged' || task.status === 'cancelled'
      if (finished && safe) due.push({ task, folder: row.worktree_path })
    }
    return due
  }

  /**
   * Remove a finished task's working folder; its branch stays, so its work can still be read.
   * Whatever is uncommitted in the folder is saved to the branch first, and if that cannot be
   * done the folder is left exactly as it is. Returns whether the folder was removed.
   */
  async removeFolder(task: Task): Promise<boolean> {
    const { git } = this.deps
    const row = this.row(task.id)
    if (!git || !row?.repo_root || !row.worktree_path || !row.branch || row.removed_at) return false
    try {
      if (await exists(row.worktree_path)) {
        if (!(await this.commit(task))) return false
        await git.removeWorktree(row.repo_root, row.worktree_path)
      }
      this.update(task.id, { removed_at: this.stamp() })
      this.publish(task, { change: 'removed', branch: row.branch })
      return true
    } catch (error) {
      this.deps.logger.warn('workspace.remove.failed', { taskId: task.id, ...describeError(error) })
      return false
    }
  }

  /** Where a mission's accepted work is collecting, for the person to review and merge themselves. */
  async missionBranches(missionId: string): Promise<MissionBranchInfo[]> {
    const { git } = this.deps
    if (!git) return []
    const rows = this.deps.db
      .prepare('SELECT * FROM mission_branches WHERE mission_id = ? ORDER BY created_at')
      .all(missionId) as Array<{ repo_root: string; branch: string; base_commit: string }>
    const found: MissionBranchInfo[] = []
    for (const row of rows) {
      try {
        // A branch the person has since deleted is simply not listed.
        if (!(await git.resolve(row.repo_root, row.branch))) continue
        found.push({
          branch: row.branch,
          repoName: pathApi(this.deps.platform).basename(row.repo_root),
          repoRoot: row.repo_root,
          base: await git.shortId(row.repo_root, row.base_commit),
          ahead: await git.commitsAhead(row.repo_root, row.base_commit, row.branch),
        })
      } catch (error) {
        this.deps.logger.warn('workspace.branch.failed', { missionId, ...describeError(error) })
      }
    }
    return found
  }

  // ---------- internals ----------

  private async discard(root: string, dir: string): Promise<void> {
    try {
      await this.deps.git?.removeWorktree(root, dir)
    } catch (error) {
      this.deps.logger.warn('workspace.discard.failed', describeError(error))
    }
  }

  /** The task runs as it always has; the record says why it was not isolated. */
  private notIsolated(task: Task, reason: string): null {
    this.upsert(task, {
      state: 'none',
      repo_root: null,
      branch: null,
      worktree_path: null,
      base_commit: null,
      head_commit: null,
      merge_commit: null,
      note: reason.slice(0, TEXT_LIMIT),
      removed_at: null,
    })
    this.publish(task, { change: 'unavailable', reason: reason.slice(0, TEXT_LIMIT) })
    return null
  }

  private row(taskId: string): Row | undefined {
    return this.deps.db.prepare('SELECT * FROM task_workspaces WHERE task_id = ?').get(taskId) as
      Row | undefined
  }

  private upsert(task: Task, values: Omit<Row, 'task_id' | 'mission_id'>): void {
    const ts = this.stamp()
    this.deps.db
      .prepare(
        `INSERT INTO task_workspaces
           (task_id, mission_id, state, repo_root, branch, worktree_path, base_commit, head_commit, merge_commit, note, removed_at, created_at, updated_at)
         VALUES (@taskId, @missionId, @state, @repo_root, @branch, @worktree_path, @base_commit, @head_commit, @merge_commit, @note, @removed_at, @ts, @ts)
         ON CONFLICT (task_id) DO UPDATE SET
           state = @state, repo_root = @repo_root, branch = @branch, worktree_path = @worktree_path,
           base_commit = @base_commit, head_commit = @head_commit, merge_commit = @merge_commit,
           note = @note, removed_at = @removed_at, updated_at = @ts`,
      )
      .run({ taskId: task.id, missionId: task.missionId, ts, ...values })
  }

  private update(taskId: string, values: Partial<Omit<Row, 'task_id' | 'mission_id'>>): void {
    const columns = Object.keys(values)
    if (columns.length === 0) return
    this.deps.db
      .prepare(
        `UPDATE task_workspaces SET ${columns.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @ts WHERE task_id = @taskId`,
      )
      .run({ taskId, ts: this.stamp(), ...values })
  }

  private publish(
    task: Task,
    detail: {
      change: 'created' | 'committed' | 'merged' | 'conflict' | 'unavailable' | 'removed'
      branch?: string
      commit?: string
      files?: string[]
      reason?: string
    },
  ): void {
    this.deps.events.publish({
      type: 'workspace.changed',
      source: 'system',
      missionId: task.missionId,
      taskId: task.id,
      ...(task.assigneeId && { actorId: task.assigneeId }),
      payload: { taskId: task.id, missionId: task.missionId, ...detail },
    })
  }

  private stamp(): string {
    return this.now().toISOString()
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/** A sentence a person can read: Git's own errors already are; anything else is generic. */
function reasonOf(error: unknown): string {
  if (error instanceof GitError) return error.message
  return 'the working folder could not be prepared'
}
