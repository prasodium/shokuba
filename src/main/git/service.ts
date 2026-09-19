import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { FileChange, HeadInfo, MergeOutcome } from '@shared/git'
import type { Logger } from '../logging/logger'
import {
  findExecutable,
  isPathInside,
  pathApi,
  removeTree,
  safeChildEnv,
  type Env,
  type PlatformId,
} from '../platform'
import { assertShokubaBranch, assertStartPoint, cleanAuthorName, workspaceKey } from './refs'
import { GitError, runGit, type RunOptions, type RunResult } from './runner'
import { isSupported, MIN_GIT, parseGitVersion, type GitVersion } from './version'

/** Commits Shokuba makes are attributed to this address; `.invalid` can never be a real one. */
const COMMIT_EMAIL = 'shokuba@localhost.invalid'
const EMPTY_TREE = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
} as const

export interface GitServiceOptions {
  executable: string
  platform: PlatformId
  /** Shokuba's own environment, filtered before Git sees it. */
  env: Env
  /** Shokuba's data folder. Worktrees live under it, never inside your project. */
  dataDir: string
  logger?: Logger
  /** Extra variables for Git itself (tests use this to ignore the machine's own Git settings). */
  gitEnv?: Record<string, string>
}

/**
 * Git, used the way a harness needs it: a branch and a working folder per task, a diff to
 * review, and merging accepted work, all without ever touching your own checkout.
 *
 * What keeps that safe:
 *  - it only creates or moves branches named `shokuba/mission/…` and `shokuba/task/…`, built
 *    from ids (see `refs.ts`), so it can never move `main`;
 *  - worktrees are created and removed only inside `<data>/worktrees`;
 *  - Git runs with an argument list, never a shell, with bounded time and output;
 *  - a repository's hooks, and the filters and merge drivers its attributes name, never run
 *    from these commands (they could otherwise run a command from a repo an agent wrote to);
 *  - merges happen in Git's object store with no checkout, so no working folder is disturbed,
 *    and a conflict leaves everything exactly as it was;
 *  - mutating commands on one repository run one at a time.
 */
export class GitService {
  readonly worktreesRoot: string
  private readonly hooksDir: string
  private readonly env: Record<string, string>
  private readonly locks = new Map<string, Promise<void>>()
  private readonly emptyTrees = new Map<string, string>()
  private prepared: Promise<void> | undefined

  constructor(private readonly options: GitServiceOptions) {
    const paths = pathApi(options.platform)
    this.worktreesRoot = paths.join(options.dataDir, 'worktrees')
    this.hooksDir = paths.join(options.dataDir, 'git', 'no-hooks')
    this.env = safeChildEnv(options.platform, options.env, {
      // Never wait for a person at a terminal prompt, and never take optional locks that would
      // make a read-only command fight a running one.
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      // Git's messages are parsed, so they must not be translated.
      LC_ALL: 'C',
      ...options.gitEnv,
    })
  }

  /** Find Git on this machine and check it is new enough. */
  static async locate(
    options: Omit<GitServiceOptions, 'executable'> & { home: string },
  ): Promise<GitService> {
    const found = await findExecutable('git', {
      platform: options.platform,
      env: options.env,
      home: options.home,
    })
    if (!found) {
      throw new GitError('failed', 'Git was not found. Install Git to work in isolated branches.')
    }
    const service = new GitService({ ...options, executable: found })
    const version = await service.version()
    if (!isSupported(version)) {
      throw new GitError(
        'unsupported',
        `Git ${version.text} is too old: Shokuba needs ${MIN_GIT.join('.')} or newer.`,
      )
    }
    return service
  }

  async version(): Promise<GitVersion> {
    await this.prepare()
    const { stdout } = await this.raw(['--version'], this.options.dataDir)
    const version = parseGitVersion(stdout)
    if (!version)
      throw new GitError('failed', `Could not tell which Git this is: "${stdout.trim()}"`)
    return version
  }

  // ---------- reading ----------

  /** The top of the repository `dir` is in, as a real path. */
  async repoRoot(dir: string): Promise<string> {
    await this.prepare()
    let result: RunResult
    try {
      result = await this.raw(['rev-parse', '--show-toplevel'], dir)
    } catch (error) {
      if (error instanceof GitError && error.code === 'failed') {
        throw new GitError('not-a-repo', 'That folder is not inside a Git repository', error.detail)
      }
      throw error
    }
    return fs.realpath(result.stdout.trim())
  }

  async head(repo: string): Promise<HeadInfo> {
    const commit = await this.tryRevParse(repo, 'HEAD')
    if (!commit) throw new GitError('no-commits', 'This repository has no commits yet')
    const branch = await this.git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      okCodes: [0, 1],
    })
    return { commit, branch: branch.code === 0 ? branch.stdout.trim() : null }
  }

  /** The commit a branch or commit id points at, or null if there is no such thing. */
  async resolve(repo: string, revision: string): Promise<string | null> {
    return this.tryRevParse(repo, assertStartPoint(revision))
  }

  /** What `head` changed since it split from `base`: for reviewing a task's work. */
  async changedFiles(repo: string, base: string, head: string): Promise<FileChange[]> {
    const { stdout } = await this.git(repo, [
      'diff',
      '--numstat',
      '--no-renames',
      '-z',
      `${assertStartPoint(base)}...${assertStartPoint(head)}`,
    ])
    return stdout
      .split('\0')
      .filter((entry) => entry.length > 0)
      .map((entry): FileChange => {
        const [added = '', deleted = '', ...rest] = entry.split('\t')
        const binary = added === '-' && deleted === '-'
        return {
          path: rest.join('\t'),
          added: binary ? null : Number(added),
          deleted: binary ? null : Number(deleted),
          binary,
        }
      })
  }

  /** The changes as text, cut off at `maxBytes` so a huge change cannot flood the app. */
  async diff(
    repo: string,
    base: string,
    head: string,
    maxBytes = 200_000,
  ): Promise<{ text: string; truncated: boolean }> {
    const { stdout, truncated } = await this.git(
      repo,
      [
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        `${assertStartPoint(base)}...${assertStartPoint(head)}`,
      ],
      { maxBytes },
    )
    return { text: stdout, truncated }
  }

  /** Where each Shokuba-visible worktree of this repository is, and which branch is in it. */
  async worktrees(repo: string): Promise<Array<{ path: string; branch: string | null }>> {
    const { stdout } = await this.git(repo, ['worktree', 'list', '--porcelain'])
    const found: Array<{ path: string; branch: string | null }> = []
    for (const block of stdout.split(/\r?\n\r?\n/)) {
      const lines = block.split(/\r?\n/)
      const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
      if (!path) continue
      const branch = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length)
      found.push({ path, branch: branch ? branch.replace(/^refs\/heads\//, '') : null })
    }
    return found
  }

  // ---------- changing ----------

  /** Make `branch` if it does not exist yet. Returns the commit it points at. */
  async ensureBranch(repo: string, branch: string, startPoint: string): Promise<string> {
    assertShokubaBranch(branch)
    assertStartPoint(startPoint)
    return this.exclusive(repo, async () => {
      const existing = await this.tryRevParse(repo, `refs/heads/${branch}`)
      if (existing) return existing
      await this.git(repo, ['branch', '--no-track', branch, startPoint])
      const made = await this.tryRevParse(repo, `refs/heads/${branch}`)
      if (!made) throw new GitError('failed', `Could not create the branch ${branch}`)
      return made
    })
  }

  /** Where a task's working folder goes: inside the data folder, keyed by the repo and task. */
  worktreePath(repo: string, key: string): string {
    const repoKey = createHash('sha256').update(repo).digest('hex').slice(0, 12)
    return pathApi(this.options.platform).join(this.worktreesRoot, repoKey, workspaceKey(key))
  }

  /** A new working folder on a new branch, cut from `startPoint`. */
  async createWorktree(
    repo: string,
    dir: string,
    branch: string,
    startPoint: string,
  ): Promise<void> {
    assertShokubaBranch(branch)
    assertStartPoint(startPoint)
    this.assertInsideWorktrees(dir)
    if (await exists(dir)) {
      throw new GitError('exists', 'That working folder already exists')
    }
    await fs.mkdir(pathApi(this.options.platform).dirname(dir), { recursive: true })
    await this.exclusive(repo, () =>
      this.git(repo, ['worktree', 'add', '--no-track', '-b', branch, dir, startPoint]),
    )
  }

  /**
   * Give an existing task branch a working folder again, for when the folder was removed but the
   * branch (and the work on it) remains.
   */
  async reattachWorktree(repo: string, dir: string, branch: string): Promise<void> {
    assertShokubaBranch(branch)
    this.assertInsideWorktrees(dir)
    if (await exists(dir)) {
      throw new GitError('exists', 'That working folder already exists')
    }
    await fs.mkdir(pathApi(this.options.platform).dirname(dir), { recursive: true })
    await this.exclusive(repo, async () => {
      await this.git(repo, ['worktree', 'prune'])
      await this.git(repo, ['worktree', 'add', dir, branch])
    })
  }

  /** Remove a working folder (the branch stays). Safe to call for one that is already gone. */
  async removeWorktree(repo: string, dir: string): Promise<void> {
    this.assertInsideWorktrees(dir)
    await this.exclusive(repo, async () => {
      await this.git(repo, ['worktree', 'remove', '--force', dir], { okCodes: [0, 128] })
      await removeTree(dir)
      await this.git(repo, ['worktree', 'prune'])
    })
  }

  /**
   * Commit whatever is uncommitted in a working folder, so the work is a commit that can be
   * reviewed and merged. Returns the new commit, or null if there was nothing to commit.
   * Files a project ignores stay ignored.
   */
  async commitAll(
    repo: string,
    dir: string,
    message: string,
    authorName: string,
  ): Promise<string | null> {
    this.assertInsideWorktrees(dir)
    const author = cleanAuthorName(authorName)
    return this.exclusive(repo, async () => {
      const status = await this.git(repo, ['status', '--porcelain=v1', '-z'], { cwd: dir })
      if (status.stdout.length === 0) return null
      await this.git(repo, ['add', '-A'], { cwd: dir })
      await this.git(
        repo,
        [
          '-c',
          `user.name=${author}`,
          '-c',
          `user.email=${COMMIT_EMAIL}`,
          'commit',
          '-q',
          '--no-verify',
          '-m',
          cleanMessage(message),
        ],
        { cwd: dir },
      )
      const commit = await this.tryRevParse(repo, 'HEAD', dir)
      if (!commit) throw new GitError('failed', 'The commit was not made')
      return commit
    })
  }

  /**
   * Merge `source` into `target` (both Shokuba branches) as a merge commit, without checking
   * anything out. A conflict is an answer, not an error: nothing is changed and the files that
   * conflict are named. The branch is moved only if it is still where the merge started, so a
   * concurrent change can never be overwritten.
   */
  async merge(
    repo: string,
    target: string,
    source: string,
    message: string,
    authorName: string,
  ): Promise<MergeOutcome> {
    assertShokubaBranch(target)
    assertShokubaBranch(source)
    const author = cleanAuthorName(authorName)
    return this.exclusive(repo, async () => {
      const worktrees = await this.worktrees(repo)
      if (worktrees.some((tree) => tree.branch === target)) {
        throw new GitError(
          'checked-out',
          `${target} is checked out in a working folder, so it cannot be moved safely`,
        )
      }
      const targetTip = await this.tryRevParse(repo, `refs/heads/${target}`)
      const sourceTip = await this.tryRevParse(repo, `refs/heads/${source}`)
      if (!targetTip) throw new GitError('failed', `There is no branch ${target}`)
      if (!sourceTip) throw new GitError('failed', `There is no branch ${source}`)

      const contained = await this.git(
        repo,
        ['merge-base', '--is-ancestor', sourceTip, targetTip],
        {
          okCodes: [0, 1],
        },
      )
      if (contained.code === 0) return { kind: 'up-to-date' }

      const merged = await this.git(
        repo,
        ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', targetTip, sourceTip],
        { okCodes: [0, 1] },
      )
      const [tree = '', ...conflicts] = merged.stdout.split('\0').filter((part) => part.length > 0)
      if (merged.code === 1) return { kind: 'conflict', files: [...new Set(conflicts)] }
      if (!/^[0-9a-f]{40,64}$/.test(tree)) {
        throw new GitError('failed', 'Git did not say what the merge produced')
      }

      const commit = (
        await this.git(repo, [
          '-c',
          `user.name=${author}`,
          '-c',
          `user.email=${COMMIT_EMAIL}`,
          'commit-tree',
          tree,
          '-p',
          targetTip,
          '-p',
          sourceTip,
          '-m',
          cleanMessage(message),
        ])
      ).stdout.trim()
      // The last argument makes this a compare-and-swap: it fails if the branch has moved.
      await this.git(repo, [
        'update-ref',
        '-m',
        'shokuba: merge',
        `refs/heads/${target}`,
        commit,
        targetTip,
      ])
      return { kind: 'merged', commit }
    })
  }

  // ---------- internals ----------

  private assertInsideWorktrees(dir: string): void {
    const { platform } = this.options
    if (!isPathInside(this.worktreesRoot, dir, platform) || dir === this.worktreesRoot) {
      throw new GitError('unsafe', 'That folder is outside where Shokuba keeps its working folders')
    }
  }

  private async tryRevParse(repo: string, revision: string, cwd?: string): Promise<string | null> {
    const result = await this.git(
      repo,
      ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`],
      {
        okCodes: [0, 1],
        ...(cwd && { cwd }),
      },
    )
    return result.code === 0 ? result.stdout.trim() : null
  }

  /** Git in `repo` with Shokuba's safety settings. */
  private async git(
    repo: string,
    args: string[],
    options: Partial<RunOptions> = {},
  ): Promise<RunResult> {
    await this.prepare()
    const prefix = [
      '-c',
      `core.hooksPath=${this.hooksDir}`,
      '-c',
      'gc.auto=0',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.longpaths=true',
      '-c',
      'core.quotePath=false',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'tag.gpgsign=false',
      // Read no attributes: they are how a repository names filters and merge drivers.
      `--attr-source=${await this.emptyTree(repo)}`,
    ]
    return runGit(this.options.executable, [...prefix, ...args], this.env, {
      cwd: repo,
      ...options,
    })
  }

  /** Git with no repository context, for the few questions asked before there is one. */
  private raw(args: string[], cwd: string, options: Partial<RunOptions> = {}): Promise<RunResult> {
    return runGit(this.options.executable, args, this.env, { cwd, ...options })
  }

  private async emptyTree(repo: string): Promise<string> {
    const known = this.emptyTrees.get(repo)
    if (known) return known
    const { stdout } = await this.raw(['rev-parse', '--show-object-format'], repo)
    const tree = stdout.trim() === 'sha256' ? EMPTY_TREE.sha256 : EMPTY_TREE.sha1
    this.emptyTrees.set(repo, tree)
    return tree
  }

  private prepare(): Promise<void> {
    this.prepared ??= (async () => {
      await fs.mkdir(this.hooksDir, { recursive: true })
      await fs.mkdir(this.worktreesRoot, { recursive: true })
      await fs.mkdir(this.options.dataDir, { recursive: true })
    })()
    return this.prepared
  }

  /** Run `work` after every earlier command on this repository has finished. */
  private async exclusive<T>(repo: string, work: () => Promise<T>): Promise<T> {
    const before = this.locks.get(repo) ?? Promise.resolve()
    const result = before.then(work)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.locks.set(repo, tail)
    try {
      return await result
    } finally {
      if (this.locks.get(repo) === tail) this.locks.delete(repo)
    }
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

function cleanMessage(message: string): string {
  return message.replace(/\0/g, '').trim().slice(0, 2000) || 'Shokuba'
}
