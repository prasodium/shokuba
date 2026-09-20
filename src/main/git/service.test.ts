import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTree, toPlatformId } from '../platform'
import { missionBranch, taskBranch } from './refs'
import { GitError } from './runner'
import { GitService, pushProblem } from './service'

let dir: string
let repo: string
let data: string
let git: GitService
let noConfig: string

/** Plain Git, for setting things up and for checking what Shokuba did. Ignores the machine's own Git settings. */
function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Setup',
      '-c',
      'user.email=setup@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: noConfig, GIT_CONFIG_NOSYSTEM: '1' },
    },
  ).trim()
}

const write = (folder: string, name: string, text: string): void =>
  writeFileSync(join(folder, name), text)
const read = (folder: string, name: string): string => readFileSync(join(folder, name), 'utf8')

beforeEach(async () => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'shokuba-git-')))
  noConfig = join(dir, 'no-git-config')
  writeFileSync(noConfig, '')
  repo = join(dir, 'repo')
  data = join(dir, 'data')
  mkdirSync(repo)
  sh(repo, 'init', '-q', '-b', 'main')
  write(repo, 'a.txt', 'one\ntwo\nthree\n')
  sh(repo, 'add', '-A')
  sh(repo, 'commit', '-qm', 'base')
  git = await GitService.locate({
    platform: toPlatformId(),
    env: process.env,
    home: homedir(),
    dataDir: data,
    gitEnv: { GIT_CONFIG_GLOBAL: noConfig, GIT_CONFIG_NOSYSTEM: '1' },
  })
})

// Git makes its files read-only, which a plain delete cannot remove on Windows.
afterEach(async () => {
  await removeTree(dir)
})

const baseCommit = (): string => sh(repo, 'rev-parse', 'HEAD')

/** A task: its branch and working folder, cut from `start`. */
async function startTask(id: string, start = baseCommit()): Promise<string> {
  const folder = git.worktreePath(repo, id)
  await git.createWorktree(repo, folder, taskBranch(id), start)
  return folder
}

async function failure(work: Promise<unknown>): Promise<GitError> {
  try {
    await work
  } catch (error) {
    expect(error).toBeInstanceOf(GitError)
    return error as GitError
  }
  throw new Error('expected a GitError')
}

describe('finding Git', () => {
  it('finds a Git new enough to use', async () => {
    const version = await git.version()
    expect(version.major).toBeGreaterThanOrEqual(2)
  })
})

describe('reading a repository', () => {
  it('finds the top of the repository from anywhere inside it, as a real path', async () => {
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true })
    expect(await git.repoRoot(join(repo, 'src', 'deep'))).toBe(realpathSync.native(repo))
  })

  it('says plainly when a folder is not in a repository', async () => {
    const elsewhere = join(dir, 'plain')
    mkdirSync(elsewhere)
    const error = await failure(git.repoRoot(elsewhere))
    expect(error.code).toBe('not-a-repo')
    expect(error.message).toBe('That folder is not inside a Git repository')
  })

  it('reports where HEAD is, on a branch or detached', async () => {
    const commit = baseCommit()
    expect(await git.head(repo)).toEqual({ commit, branch: 'main' })
    sh(repo, 'checkout', '-q', '--detach')
    expect(await git.head(repo)).toEqual({ commit, branch: null })
  })

  it('says so when there are no commits yet', async () => {
    const empty = join(dir, 'empty')
    mkdirSync(empty)
    sh(empty, 'init', '-q', '-b', 'main')
    expect((await failure(git.head(await git.repoRoot(empty)))).code).toBe('no-commits')
  })
})

describe('a repository’s remote', () => {
  it('is where origin points, as Git would use it', async () => {
    sh(repo, 'remote', 'add', 'origin', 'https://github.com/octo/widgets.git')
    expect(await git.remoteUrl(repo)).toBe('https://github.com/octo/widgets.git')
  })

  it('follows a rewrite the person set up, because that is what Git would push to', async () => {
    sh(repo, 'remote', 'add', 'origin', 'https://github.com/octo/widgets.git')
    sh(repo, 'config', 'url.git@github.com:.insteadOf', 'https://github.com/')
    expect(await git.remoteUrl(repo)).toBe('git@github.com:octo/widgets.git')
  })

  it('can name another remote', async () => {
    sh(repo, 'remote', 'add', 'origin', 'https://github.com/octo/widgets.git')
    sh(repo, 'remote', 'add', 'fork', 'https://github.com/me/widgets.git')
    expect(await git.remoteUrl(repo, 'fork')).toBe('https://github.com/me/widgets.git')
  })

  it('is null when there is no such remote, rather than an error', async () => {
    expect(await git.remoteUrl(repo)).toBeNull()
    expect(await git.remoteUrl(repo, 'nope')).toBeNull()
  })

  it('will not take a remote name that could be read as an option', async () => {
    sh(repo, 'remote', 'add', 'origin', 'https://github.com/octo/widgets.git')
    for (const name of ['--all', '-v', '', 'a b', 'a;b', '../x', 'x'.repeat(200)]) {
      expect(await git.remoteUrl(repo, name), name).toBeNull()
    }
  })
})

describe('a remote’s pushed-to address and last known branch', () => {
  it('can say where a push goes, apart from where a fetch comes from', async () => {
    sh(repo, 'remote', 'add', 'origin', 'https://github.com/octo/widgets.git')
    sh(repo, 'remote', 'set-url', '--push', 'origin', 'git@github.com:octo/widgets.git')
    expect(await git.remoteUrl(repo)).toBe('https://github.com/octo/widgets.git')
    expect(await git.remoteUrl(repo, 'origin', 'push')).toBe('git@github.com:octo/widgets.git')
    expect(await git.remoteUrl(repo, 'nope', 'push')).toBeNull()
  })

  it('knows where a remote’s branch was when last fetched, and not what it never had', async () => {
    const commit = baseCommit()
    expect(await git.remoteTip(repo, 'origin', 'main')).toBeNull()
    sh(repo, 'update-ref', 'refs/remotes/origin/main', commit)
    expect(await git.remoteTip(repo, 'origin', 'main')).toBe(commit)
    expect(await git.remoteTip(repo, 'origin', 'feature/x')).toBeNull()
  })

  it('will not take a name that could be read as an option or a path trick', async () => {
    sh(repo, 'update-ref', 'refs/remotes/origin/main', baseCommit())
    for (const branch of ['--all', '-x', '', 'a..b', 'a//b', 'main/', 'a b', 'x'.repeat(101)]) {
      expect(await git.remoteTip(repo, 'origin', branch), branch).toBeNull()
    }
    for (const remote of ['--all', '', 'a b', '../x']) {
      expect(await git.remoteTip(repo, remote, 'main'), remote).toBeNull()
    }
  })
})

describe('pushing a branch', () => {
  const BRANCH = missionBranch('m1')
  let bare: string
  let tip: string

  /** A commit added to the mission branch, and the branch's new tip. */
  const commitOnBranch = (name: string): string => {
    sh(repo, 'switch', '-q', BRANCH)
    write(repo, name, `${name}\n`)
    sh(repo, 'add', '-A')
    sh(repo, 'commit', '-qm', `add ${name}`)
    const made = sh(repo, 'rev-parse', 'HEAD')
    sh(repo, 'switch', '-q', 'main')
    return made
  }
  const remoteTipOf = (branch = BRANCH): string => sh(bare, 'rev-parse', `refs/heads/${branch}`)
  const refusal = async (work: Promise<unknown>): Promise<GitError> => failure(work)
  /** The address of the local folder that stands in for GitHub: a file address, as a real one is a URL. */
  const remote = (): string => pathToFileURL(bare).href

  beforeEach(() => {
    bare = join(dir, 'remote.git')
    sh(dir, 'init', '--bare', '-q', '-b', 'main', bare)
    sh(repo, 'branch', BRANCH)
    tip = commitOnBranch('one.txt')
  })

  it('makes the branch on the other side, then finds it there, then moves it forward', async () => {
    expect(await git.push(repo, remote(), BRANCH, tip)).toBe('created')
    expect(remoteTipOf()).toBe(tip)
    expect(await git.push(repo, remote(), BRANCH, tip)).toBe('up-to-date')
    const next = commitOnBranch('two.txt')
    expect(await git.push(repo, remote(), BRANCH, next)).toBe('updated')
    expect(remoteTipOf()).toBe(next)
  })

  it('pushes the commit it was given, even when the branch has moved on since', async () => {
    const later = commitOnBranch('later.txt')
    expect(await git.push(repo, remote(), BRANCH, tip)).toBe('created')
    expect(remoteTipOf()).toBe(tip)
    expect(remoteTipOf()).not.toBe(later)
  })

  it('pushes only that branch: nothing else of yours goes, and none of yours moves', async () => {
    sh(repo, 'branch', 'my-feature')
    const main = sh(repo, 'rev-parse', 'main')
    await git.push(repo, remote(), BRANCH, tip)
    expect(sh(bare, 'for-each-ref', '--format=%(refname)')).toBe(`refs/heads/${BRANCH}`)
    expect(sh(repo, 'rev-parse', 'main')).toBe(main)
    expect(sh(repo, 'rev-parse', BRANCH)).toBe(tip)
  })

  it('never pushes a branch that is not one of Shokuba’s, whatever it is called', async () => {
    for (const name of [
      'main',
      'my-feature',
      'shokuba/other/x',
      'refs/heads/main',
      '--all',
      '',
      'shokuba/mission/../x',
    ]) {
      expect((await refusal(git.push(repo, remote(), name, tip))).code, name).toBe('unsafe')
    }
    expect(sh(bare, 'for-each-ref')).toBe('')
  })

  it('takes only a full commit id, never a name or an expression', async () => {
    for (const commit of ['HEAD', 'main', BRANCH, tip.slice(0, 8), '', `${tip}~1`, `--${tip}`]) {
      expect((await refusal(git.push(repo, remote(), BRANCH, commit))).code, commit).toBe('unsafe')
    }
    expect(sh(bare, 'for-each-ref')).toBe('')
  })

  it('will not push a commit that is not on the branch', async () => {
    sh(repo, 'switch', '-q', '-c', 'elsewhere', 'main')
    write(repo, 'x.txt', 'x\n')
    sh(repo, 'add', '-A')
    sh(repo, 'commit', '-qm', 'not on the branch')
    const stray = sh(repo, 'rev-parse', 'HEAD')
    sh(repo, 'switch', '-q', 'main')
    expect((await refusal(git.push(repo, remote(), BRANCH, stray))).message).toMatch(
      /not on the branch/,
    )
    expect(sh(bare, 'for-each-ref')).toBe('')
  })

  it('will not push to an address that could be read as an option', async () => {
    for (const url of [
      '--receive-pack=touch pwned',
      '-x',
      '',
      'a b',
      'x;y',
      '$(x)',
      'x'.repeat(501),
    ]) {
      expect((await refusal(git.push(repo, url, BRANCH, tip))).code, url).toBe('unsafe')
    }
  })

  it('never overwrites: work that is already there, which is not a continuation, is left alone', async () => {
    const other = join(dir, 'other-clone')
    sh(dir, 'clone', '-q', bare, other)
    sh(other, 'switch', '-q', '-c', BRANCH)
    write(other, 'theirs.txt', 'theirs\n')
    sh(other, 'add', '-A')
    sh(other, 'commit', '-qm', 'someone else’s work')
    sh(other, 'push', '-q', 'origin', BRANCH)
    const theirs = remoteTipOf()

    const error = await refusal(git.push(repo, remote(), BRANCH, tip))
    expect(error.code).toBe('failed')
    expect(error.message).toMatch(/Nothing was overwritten/)
    expect(remoteTipOf()).toBe(theirs)
  })

  it('says how to fix a push that cannot sign in or find the repository, in plain words', async () => {
    const error = await refusal(
      git.push(repo, pathToFileURL(join(dir, 'no-such-place.git')).href, BRANCH, tip),
    )
    expect(error.code).toBe('failed')
    expect(error.message).toMatch(/not found, or you may not push/)
    expect(error.message).not.toContain(dir)
  })

  it.each([
    ['core.sshCommand', 'echo pwned'],
    ['core.askPass', '/tmp/x'],
    ['credential.helper', '!echo pwned'],
    ['url.https://evil.example/.insteadOf', 'https://github.com/'],
    ['remote.origin.pushurl', 'https://evil.example/x.git'],
    ['remote.origin.receivepack', 'evil'],
    ['http.extraHeader', 'Authorization: token-value'],
    ['include.path', '/tmp/more'],
    ['push.gpgSign', 'true'],
  ])(
    'refuses to push when the repository’s own settings say %s, and pushes nothing',
    async (key, value) => {
      sh(repo, 'remote', 'add', 'origin', 'https://github.com/octo/widgets.git')
      sh(repo, 'config', '--local', key, value)
      const error = await refusal(git.push(repo, remote(), BRANCH, tip))
      expect(error.code).toBe('unsafe')
      expect(error.message).toMatch(/will not push from it/)
      expect(error.message).toMatch(/git config --global/)
      expect(error.message).not.toContain(value)
      expect(sh(bare, 'for-each-ref')).toBe('')
    },
  )

  it('uses your own global settings as they are, even ones it would refuse in the repository', async () => {
    writeFileSync(noConfig, '[credential]\n\thelper = cache\n[core]\n\tsshCommand = ssh\n')
    expect(await git.push(repo, remote(), BRANCH, tip)).toBe('created')
  })

  it('never runs a hook the repository has', async () => {
    const marker = join(dir, 'hook-ran')
    const hook = join(repo, '.git', 'hooks', 'pre-push')
    writeFileSync(hook, `#!/bin/sh\ntouch "${marker.replace(/\\/g, '/')}"\n`, { mode: 0o755 })
    await git.push(repo, remote(), BRANCH, tip)
    expect(existsSync(marker)).toBe(false)
  })

  it('does not put the repository’s address or any login in what it reports', async () => {
    const error = await refusal(
      git.push(repo, pathToFileURL(join(dir, 'x-user-secret-name.git')).href, BRANCH, tip),
    )
    expect(error.message).not.toContain('secret-name')
  })
})

describe('branches', () => {
  it('makes a mission branch once, and leaves an existing one alone', async () => {
    const start = baseCommit()
    const made = await git.ensureBranch(repo, missionBranch('m1'), start)
    expect(made).toBe(start)
    write(repo, 'b.txt', 'later\n')
    sh(repo, 'add', '-A')
    sh(repo, 'commit', '-qm', 'later')
    // Asked again with a newer start point, it stays where it was.
    expect(await git.ensureBranch(repo, missionBranch('m1'), baseCommit())).toBe(start)
  })

  it('will not touch a branch it does not manage, however it is asked', async () => {
    const before = sh(repo, 'rev-parse', 'main')
    for (const name of [
      'main',
      'master',
      'shokuba',
      'shokuba/other/x',
      'shokuba/mission/../main',
    ]) {
      expect((await failure(git.ensureBranch(repo, name, baseCommit()))).code, name).toBe('unsafe')
    }
    expect(sh(repo, 'rev-parse', 'main')).toBe(before)
  })

  it('will not start a branch from something that is not a commit id or one of its own branches', async () => {
    for (const start of ['HEAD', 'main', '--force', 'HEAD~1', '$(x)']) {
      expect((await failure(git.ensureBranch(repo, missionBranch('m2'), start))).code, start).toBe(
        'unsafe',
      )
    }
  })
})

describe('a task’s working folder', () => {
  it('is a new branch cut from the start point, in its own folder, and your checkout is untouched', async () => {
    const folder = await startTask('t1')
    expect(folder.startsWith(git.worktreesRoot)).toBe(true)
    expect(read(folder, 'a.txt')).toBe('one\ntwo\nthree\n')
    expect(sh(folder, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('shokuba/task/t1')
    expect(sh(repo, 'status', '--short')).toBe('')
    expect(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(existsSync(join(repo, '.shokuba'))).toBe(false)
  })

  it('can be several at once, each with its own work', async () => {
    const a = await startTask('ta')
    const b = await startTask('tb')
    write(a, 'a.txt', 'changed in a\n')
    expect(read(b, 'a.txt')).toBe('one\ntwo\nthree\n')
    expect(read(repo, 'a.txt')).toBe('one\ntwo\nthree\n')
  })

  it('refuses a folder that already exists, or one outside the data folder', async () => {
    const folder = await startTask('t2')
    expect(
      (await failure(git.createWorktree(repo, folder, taskBranch('t2b'), baseCommit()))).code,
    ).toBe('exists')
    for (const outside of [
      join(dir, 'elsewhere'),
      join(repo, 'inside-the-project'),
      git.worktreesRoot,
    ]) {
      const error = await failure(git.createWorktree(repo, outside, taskBranch('t3'), baseCommit()))
      expect(error.code, outside).toBe('unsafe')
    }
    expect(existsSync(join(dir, 'elsewhere'))).toBe(false)
  })

  it('is removed with its folder, keeps its branch, and can be removed twice', async () => {
    const folder = await startTask('t4')
    write(folder, 'a.txt', 'work\n')
    await git.removeWorktree(repo, folder)
    expect(existsSync(folder)).toBe(false)
    expect(sh(repo, 'branch', '--list', 'shokuba/task/t4')).toContain('shokuba/task/t4')
    expect(sh(repo, 'worktree', 'list')).not.toContain('t4')
    await expect(git.removeWorktree(repo, folder)).resolves.toBeUndefined()
  })

  it('will not remove a folder outside the data folder', async () => {
    write(repo, 'precious.txt', 'keep me\n')
    expect((await failure(git.removeWorktree(repo, repo))).code).toBe('unsafe')
    expect((await failure(git.removeWorktree(repo, join(repo, 'src')))).code).toBe('unsafe')
    expect(read(repo, 'precious.txt')).toBe('keep me\n')
  })

  it('keeps its keys plain, so a key can never point somewhere else', () => {
    expect(() => git.worktreePath(repo, '../escape')).toThrow(GitError)
    expect(() => git.worktreePath(repo, 'a/b')).toThrow(GitError)
    expect(git.worktreePath(repo, 'abc-123')).toBe(git.worktreePath(repo, 'abc-123'))
    expect(git.worktreePath(repo, 'x')).not.toBe(git.worktreePath(join(dir, 'other'), 'x'))
  })

  it('can be made several at a time without Git tripping over itself', async () => {
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']
    await Promise.all(ids.map((id) => startTask(id)))
    const listed = sh(repo, 'worktree', 'list')
    for (const id of ids) expect(listed).toContain(`shokuba/task/${id}`)
  })
})

describe('a folder to read the work in', () => {
  it('is the code at a commit, on no branch, and leaves your checkout alone', async () => {
    const folder = await startTask('d1')
    write(folder, 'a.txt', 'one\nTWO\nthree\n')
    const commit = (await git.commitAll(repo, folder, 'work', 'Ren')) as string
    const reading = git.worktreePath(repo, 'review-d1')
    await git.createDetachedWorktree(repo, reading, commit)

    expect(read(reading, 'a.txt')).toBe('one\nTWO\nthree\n')
    expect(sh(reading, 'rev-parse', 'HEAD')).toBe(commit)
    expect(sh(reading, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD') // detached: no branch
    expect(sh(repo, 'status', '--short')).toBe('')
    expect(sh(repo, 'branch', '--list', '*review*')).toBe('')
  })

  it('cannot change the task’s work, whatever is done in it', async () => {
    const folder = await startTask('d2')
    write(folder, 'a.txt', 'one\nTWO\nthree\n')
    const commit = (await git.commitAll(repo, folder, 'work', 'Ren')) as string
    const reading = git.worktreePath(repo, 'review-d2')
    await git.createDetachedWorktree(repo, reading, commit)

    write(reading, 'a.txt', 'a reviewer scribbled here\n')
    sh(reading, 'add', '-A')
    sh(reading, 'commit', '-qm', 'scribble')
    // The task's branch and its own folder are untouched.
    expect(sh(repo, 'rev-parse', taskBranch('d2'))).toBe(commit)
    expect(read(folder, 'a.txt')).toBe('one\nTWO\nthree\n')
  })

  it('takes only a full commit id or one of its own branches, and only inside its data folder', async () => {
    const commit = baseCommit()
    for (const bad of ['HEAD', 'main', '--force']) {
      const error = await failure(
        git.createDetachedWorktree(repo, git.worktreePath(repo, 'review-d3'), bad),
      )
      expect(error.code, bad).toBe('unsafe')
    }
    expect(
      (await failure(git.createDetachedWorktree(repo, join(dir, 'elsewhere'), commit))).code,
    ).toBe('unsafe')
    expect(existsSync(join(dir, 'elsewhere'))).toBe(false)
  })

  it('is removed like any working folder', async () => {
    const reading = git.worktreePath(repo, 'review-d4')
    await git.createDetachedWorktree(repo, reading, baseCommit())
    await git.removeWorktree(repo, reading)
    expect(existsSync(reading)).toBe(false)
    expect(sh(repo, 'worktree', 'list')).not.toContain('review-d4')
  })
})

describe('committing a task’s work', () => {
  it('says nothing changed when nothing did', async () => {
    const folder = await startTask('c1')
    expect(await git.commitAll(repo, folder, 'nothing', 'Ren')).toBeNull()
  })

  it('commits changes and new files as the employee, never as you', async () => {
    const folder = await startTask('c2')
    write(folder, 'a.txt', 'one\nTWO\nthree\n')
    write(folder, 'new.txt', 'brand new\n')
    const commit = await git.commitAll(repo, folder, 'Task: change things', 'Ren')
    expect(commit).toBe(sh(folder, 'rev-parse', 'HEAD'))
    expect(sh(folder, 'log', '-1', '--format=%an|%ae|%cn|%ce|%s')).toBe(
      'Ren|shokuba@localhost.invalid|Ren|shokuba@localhost.invalid|Task: change things',
    )
    expect(sh(folder, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([
      'a.txt',
      'new.txt',
    ])
    expect(sh(folder, 'status', '--short')).toBe('')
  })

  it('leaves ignored files out', async () => {
    write(repo, '.gitignore', 'node_modules/\n*.log\n')
    sh(repo, 'add', '-A')
    sh(repo, 'commit', '-qm', 'ignore')
    const folder = await startTask('c3')
    mkdirSync(join(folder, 'node_modules'))
    write(folder, 'node_modules/big.js', 'x')
    write(folder, 'debug.log', 'noise')
    write(folder, 'kept.txt', 'kept')
    await git.commitAll(repo, folder, 'work', 'Ren')
    expect(sh(folder, 'show', '--name-only', '--format=', 'HEAD')).toBe('kept.txt')
  })

  it('cleans an author name that is not a plain name', async () => {
    const folder = await startTask('c4')
    write(folder, 'x.txt', 'x')
    await git.commitAll(repo, folder, 'work', '  <Evil>\nName  ')
    expect(sh(folder, 'log', '-1', '--format=%an')).toBe('EvilName')
  })

  it('refuses a folder that is not one of its working folders', async () => {
    write(repo, 'a.txt', 'changed in the real checkout\n')
    expect((await failure(git.commitAll(repo, repo, 'no', 'Ren'))).code).toBe('unsafe')
    expect(sh(repo, 'log', '--oneline')).toBe(sh(repo, 'log', '--oneline'))
    expect(sh(repo, 'rev-list', '--count', 'HEAD')).toBe('1')
  })
})

describe('reviewing what a task changed', () => {
  it('lists changed files with their counts, and marks binary ones', async () => {
    const folder = await startTask('r1')
    write(folder, 'a.txt', 'one\ntwo\nthree\nfour\nfive\n')
    write(folder, 'new.txt', 'a\nb\n')
    writeFileSync(join(folder, 'pic.bin'), Buffer.from([0, 1, 2, 0, 255, 0]))
    await git.commitAll(repo, folder, 'work', 'Ren')
    const files = await git.changedFiles(repo, baseCommit(), taskBranch('r1'))
    expect(files.sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: 'a.txt', added: 2, deleted: 0, binary: false },
      { path: 'new.txt', added: 2, deleted: 0, binary: false },
      { path: 'pic.bin', added: null, deleted: null, binary: true },
    ])
  })

  it('shows only what the task did, not what the base branch did since', async () => {
    const folder = await startTask('r2')
    write(folder, 'mine.txt', 'mine\n')
    await git.commitAll(repo, folder, 'work', 'Ren')
    write(repo, 'others.txt', 'someone else\n')
    sh(repo, 'add', '-A')
    sh(repo, 'commit', '-qm', 'elsewhere')
    const files = await git.changedFiles(repo, sh(repo, 'rev-parse', 'HEAD'), taskBranch('r2'))
    expect(files.map((f) => f.path)).toEqual(['mine.txt'])
  })

  it('gives the diff as text, cut off where it is too big', async () => {
    const folder = await startTask('r3')
    write(folder, 'big.txt', 'line of text\n'.repeat(5000))
    await git.commitAll(repo, folder, 'work', 'Ren')
    const full = await git.diff(repo, baseCommit(), taskBranch('r3'), 10_000_000)
    expect(full.truncated).toBe(false)
    expect(full.text).toContain('+line of text')
    const cut = await git.diff(repo, baseCommit(), taskBranch('r3'), 1000)
    expect(cut.truncated).toBe(true)
    expect(cut.text.length).toBeLessThanOrEqual(1000)
  })

  it('takes nothing but commit ids and its own branches as what to compare', async () => {
    expect((await failure(git.changedFiles(repo, 'main', taskBranch('r1')))).code).toBe('unsafe')
    expect((await failure(git.diff(repo, '--output=/tmp/x', taskBranch('r1')))).code).toBe('unsafe')
  })
})

describe('listing a task’s commits', () => {
  it('names each commit, who made it and when, newest first', async () => {
    const folder = await startTask('c1')
    write(folder, 'a.txt', 'one\nTWO\nthree\n')
    await git.commitAll(repo, folder, 'First change', 'Ren')
    write(folder, 'b.txt', 'b\n')
    await git.commitAll(repo, folder, 'Second change', 'Sora')
    const { commits, truncated } = await git.commits(repo, baseCommit(), taskBranch('c1'))
    expect(truncated).toBe(false)
    expect(commits.map((c) => [c.author, c.subject, c.merge])).toEqual([
      ['Sora', 'Second change', false],
      ['Ren', 'First change', false],
    ])
    expect(commits[0]?.commit).toBe(sh(repo, 'rev-parse', taskBranch('c1')))
    expect(commits[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('has nothing to list for a branch that has not moved', async () => {
    await startTask('c2')
    expect(await git.commits(repo, baseCommit(), taskBranch('c2'))).toEqual({
      commits: [],
      truncated: false,
    })
  })

  it('says when it cut the list short, keeping the newest', async () => {
    const folder = await startTask('c3')
    for (const n of [1, 2, 3]) {
      write(folder, `f${n}.txt`, `${n}\n`)
      await git.commitAll(repo, folder, `Change ${n}`, 'Ren')
    }
    const cut = await git.commits(repo, baseCommit(), taskBranch('c3'), 2)
    expect(cut.truncated).toBe(true)
    expect(cut.commits.map((c) => c.subject)).toEqual(['Change 3', 'Change 2'])
  })

  it('leaves out work that reached the branch by being merged in, and marks its own merge', async () => {
    const mission = await git.ensureBranch(repo, missionBranch('cm'), baseCommit())
    const folder = await startTask('c4', mission)
    write(folder, 'mine.txt', 'mine\n')
    await git.commitAll(repo, folder, 'My work', 'Ren')
    // Someone else's work lands on the mission branch, and the task pulls it in with a merge.
    const other = await startTask('c5', mission)
    write(other, 'theirs.txt', 'theirs\n')
    await git.commitAll(repo, other, 'Their work', 'Sora')
    await git.merge(repo, missionBranch('cm'), taskBranch('c5'), 'Accept: theirs', 'Shokuba')
    sh(folder, 'merge', '--no-edit', '-m', 'Bring in the mission branch', missionBranch('cm'))
    const { commits } = await git.commits(repo, mission, taskBranch('c4'))
    expect(commits.map((c) => [c.subject, c.merge])).toEqual([
      ['Bring in the mission branch', true],
      ['My work', false],
    ])
  })

  it('takes nothing but commit ids and its own branches', async () => {
    expect((await failure(git.commits(repo, 'main', taskBranch('c1')))).code).toBe('unsafe')
    expect((await failure(git.commits(repo, '--all', taskBranch('c1')))).code).toBe('unsafe')
  })
})

describe('merging accepted work', () => {
  /** A mission branch and a finished task on it, editing `a.txt` line two. */
  async function finishedTask(id: string, mission: string, text: string, file = 'a.txt') {
    const folder = await startTask(
      id,
      await git.ensureBranch(repo, missionBranch(mission), baseCommit()),
    )
    write(folder, file, text)
    await git.commitAll(repo, folder, `Task ${id}`, 'Ren')
    return folder
  }

  it('merges a task into the mission branch as a merge commit, touching no checkout', async () => {
    await finishedTask('m1', 'mm', 'one\nTWO\nthree\n')
    const mainBefore = sh(repo, 'rev-parse', 'main')
    const outcome = await git.merge(
      repo,
      missionBranch('mm'),
      taskBranch('m1'),
      'Accept: m1',
      'Shokuba',
    )
    expect(outcome.kind).toBe('merged')
    expect(
      sh(repo, 'rev-list', '--parents', '-n', '1', missionBranch('mm')).split(' '),
    ).toHaveLength(3)
    expect(sh(repo, 'show', `${missionBranch('mm')}:a.txt`)).toBe('one\nTWO\nthree')
    // Your branch and your checkout never moved.
    expect(sh(repo, 'rev-parse', 'main')).toBe(mainBefore)
    expect(sh(repo, 'status', '--short')).toBe('')
    expect(read(repo, 'a.txt')).toBe('one\ntwo\nthree\n')
  })

  it('merges tasks one after another, and combines changes to different lines', async () => {
    await finishedTask('m2', 'mn', 'one\nTWO\nthree\n')
    await finishedTask('m3', 'mn', 'one\ntwo\nthree\nfour\n')
    expect((await git.merge(repo, missionBranch('mn'), taskBranch('m2'), 'a', 'S')).kind).toBe(
      'merged',
    )
    expect((await git.merge(repo, missionBranch('mn'), taskBranch('m3'), 'b', 'S')).kind).toBe(
      'merged',
    )
    expect(sh(repo, 'show', `${missionBranch('mn')}:a.txt`)).toBe('one\nTWO\nthree\nfour')
  })

  it('reports a conflict by file, and changes nothing', async () => {
    await finishedTask('m4', 'mo', 'one\nFROM-M4\nthree\n')
    await finishedTask('m5', 'mo', 'one\nFROM-M5\nthree\n')
    await git.merge(repo, missionBranch('mo'), taskBranch('m4'), 'a', 'S')
    const tip = sh(repo, 'rev-parse', missionBranch('mo'))
    const outcome = await git.merge(repo, missionBranch('mo'), taskBranch('m5'), 'b', 'S')
    expect(outcome).toEqual({ kind: 'conflict', files: ['a.txt'] })
    expect(sh(repo, 'rev-parse', missionBranch('mo'))).toBe(tip)
    expect(sh(repo, 'status', '--short')).toBe('')
  })

  it('says when there is nothing to merge', async () => {
    await finishedTask('m6', 'mp', 'one\nTWO\nthree\n')
    await git.merge(repo, missionBranch('mp'), taskBranch('m6'), 'a', 'S')
    expect(await git.merge(repo, missionBranch('mp'), taskBranch('m6'), 'again', 'S')).toEqual({
      kind: 'up-to-date',
    })
  })

  it('never merges into a branch it does not manage', async () => {
    await finishedTask('m7', 'mq', 'one\nTWO\nthree\n')
    const mainBefore = sh(repo, 'rev-parse', 'main')
    for (const target of ['main', 'HEAD', taskBranch('other-not-made') + '/x']) {
      expect(
        (await failure(git.merge(repo, target, taskBranch('m7'), 'x', 'S'))).code,
        target,
      ).toBe('unsafe')
    }
    expect(sh(repo, 'rev-parse', 'main')).toBe(mainBefore)
  })

  it('will not move a branch that is checked out somewhere', async () => {
    const mission = missionBranch('mr')
    await git.ensureBranch(repo, mission, baseCommit())
    sh(repo, 'worktree', 'add', join(dir, 'checked-out'), mission)
    await finishedTask('m8', 'ms', 'one\nTWO\nthree\n')
    const error = await failure(git.merge(repo, mission, taskBranch('m8'), 'x', 'S'))
    expect(error.code).toBe('checked-out')
  })

  it('does not overwrite a branch that someone else moved while it was merging', async () => {
    await finishedTask('m10', 'mu', 'one\nTWO\nthree\n')
    const target = missionBranch('mu')
    const movedTo = sh(repo, 'rev-parse', taskBranch('m10'))
    const internal = git as unknown as {
      git: (repo: string, args: string[], options?: object) => Promise<unknown>
    }
    const original = internal.git.bind(git)
    // Just before Shokuba records its merge, another process moves the branch.
    vi.spyOn(internal, 'git').mockImplementation(async (where, args, options) => {
      if (args[0] === 'update-ref') sh(repo, 'update-ref', `refs/heads/${target}`, movedTo)
      return original(where, args, options)
    })
    await expect(git.merge(repo, target, taskBranch('m10'), 'x', 'S')).rejects.toBeInstanceOf(
      GitError,
    )
    // The other process's change stands; Shokuba's merge commit was not written over it.
    expect(sh(repo, 'rev-parse', target)).toBe(movedTo)
  })

  it('says so when a branch does not exist', async () => {
    await finishedTask('m9', 'mt', 'one\nTWO\nthree\n')
    const error = await failure(
      git.merge(repo, missionBranch('missing'), taskBranch('m9'), 'x', 'S'),
    )
    expect(error.message).toContain('There is no branch shokuba/mission/missing')
  })
})

describe('what a repository cannot make Shokuba run', () => {
  /** A small program that records that it ran, and passes input through unchanged. */
  function tripwire(name: string): { command: string; marker: string } {
    const marker = join(dir, `${name}-ran`)
    const script = join(dir, `${name}.cjs`)
    writeFileSync(
      script,
      "require('fs').appendFileSync(process.argv[2], 'ran'); process.stdin.pipe(process.stdout)\n",
    )
    const quote = (path: string): string => `"${path.replace(/\\/g, '/')}"`
    return { command: `${quote(process.execPath)} ${quote(script)} ${quote(marker)}`, marker }
  }

  it('does not run its hooks', async () => {
    const { command, marker } = tripwire('hook')
    const hook = join(repo, '.git', 'hooks', 'post-checkout')
    writeFileSync(hook, `#!/bin/sh\n${command}\n`, { mode: 0o755 })

    // Control: Git on its own does run the hook when it makes a working folder.
    sh(repo, 'worktree', 'add', '-q', '-b', 'control', join(dir, 'control-tree'))
    expect(existsSync(marker), 'the hook should fire under plain Git').toBe(true)
    rmSync(marker)

    // Shokuba's own commands never run it.
    const folder = await startTask('h1')
    write(folder, 'x.txt', 'x')
    await git.commitAll(repo, folder, 'work', 'Ren')
    await git.removeWorktree(repo, folder)
    expect(existsSync(marker)).toBe(false)
  })

  it('does not run filters that its attributes name', async () => {
    const { command, marker } = tripwire('filter')
    write(repo, '.gitattributes', '*.txt filter=tripwire\n')
    sh(repo, 'add', '-A')
    sh(repo, 'commit', '-qm', 'attributes')
    sh(repo, 'config', 'filter.tripwire.clean', command)

    // Control: plain Git runs the filter when it stages a text file.
    write(repo, 'control.txt', 'control\n')
    sh(repo, 'add', 'control.txt')
    expect(existsSync(marker), 'the filter should fire under plain Git').toBe(true)
    sh(repo, 'reset', '-q')
    rmSync(join(repo, 'control.txt'))
    rmSync(marker)

    const folder = await startTask('f1')
    write(folder, 'work.txt', 'work\n')
    await git.commitAll(repo, folder, 'work', 'Ren')
    expect(existsSync(marker)).toBe(false)
  })
})

describe('the words for a push that failed', () => {
  const said = (detail: string): GitError => {
    const out = pushProblem(new GitError('failed', 'raw', detail))
    expect(out).toBeInstanceOf(GitError)
    return out as GitError
  }

  it('says work that is already there was not overwritten', () => {
    for (const detail of [
      '! [rejected]        x -> x (non-fast-forward)',
      '!\trefs/heads/x:refs/heads/x\t[rejected] (fetch first)',
      ' ! [rejected]        shokuba/mission/m1 -> shokuba/mission/m1 (fetch first)\nerror: failed to push some refs',
    ]) {
      expect(said(detail).message, detail).toMatch(/Nothing was overwritten/)
    }
  })

  it('knows each of the ways Git says work was not a continuation', () => {
    for (const detail of ['non-fast-forward', '[rejected]', 'fetch first', '(rejected)']) {
      expect(said(detail).message, detail).toMatch(/Nothing was overwritten/)
    }
  })

  it('says a protected branch refused it', () => {
    for (const detail of [
      'remote: error: GH006: Protected branch update failed',
      'protected branch hook declined',
    ]) {
      expect(said(detail).message, detail).toBe('GitHub refused the push: the branch is protected.')
    }
  })

  it('says how to fix signing in, for every way Git says it could not', () => {
    for (const detail of [
      'git@github.com: Permission denied (publickey).',
      "fatal: Authentication failed for 'https://github.com/o/r.git/'",
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      'fatal: could not read Password for x',
      'remote: Invalid username or password.',
      'Host key verification failed.',
      'remote: No anonymous write access.',
    ]) {
      expect(said(detail).message, detail).toMatch(/could not sign in to push.*your own Git setup/)
    }
  })

  it('says the repository was not found, or may not be pushed to', () => {
    for (const detail of [
      'ERROR: Repository not found.',
      "fatal: '/x.git' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights",
      'remote: Not Found',
    ]) {
      expect(said(detail).message, detail).toMatch(/not found, or you may not push/)
    }
  })

  it('does not call a server’s own refusal a matter of overwriting', () => {
    expect(
      said('error: failed to push some refs\n ! [remote rejected] x -> x (hook)').message,
    ).toBe('Git could not push: error: failed to push some refs')
  })

  it('gives Git’s own first line for anything else, and a plain sentence when there is none', () => {
    expect(said('warning: x\nfatal: something odd happened here\nmore').message).toBe(
      'Git could not push: fatal: something odd happened here',
    )
    expect(said('remote: a remote said something').message).toBe(
      'Git could not push: remote: a remote said something',
    )
    expect(said('nothing useful').message).toBe('Git could not push.')
    expect(said('fatal: ' + 'x'.repeat(500)).message.length).toBeLessThan(230)
  })

  it('never puts a token or a login from Git’s output into the message or the detail', () => {
    const token = ['ghp', '_', 'a'.repeat(36)].join('')
    const out = said(
      `fatal: unable to access 'https://${token}@github.com/o/r.git/': The requested URL returned error: 500`,
    )
    expect(out.message).not.toContain(token)
    expect(out.detail).not.toContain(token)
  })

  it('leaves a timeout, and anything that is not a failed push, exactly as it was', () => {
    const timeout = new GitError('timeout', 'Git took longer than 120s and was stopped')
    expect(pushProblem(timeout)).toBe(timeout)
    const unsafe = new GitError('unsafe', 'x')
    expect(pushProblem(unsafe)).toBe(unsafe)
    const other = new Error('boom')
    expect(pushProblem(other)).toBe(other)
  })
})
