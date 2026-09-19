import { describe, expect, it } from 'vitest'
import type { MissionBranchInfo } from '@shared/git'
import { branchSummary, mergeInstructions, quotePath } from './merge'

const info = (patch: Partial<MissionBranchInfo> = {}): MissionBranchInfo => ({
  branch: 'shokuba/mission/abc-123',
  repoName: 'my-project',
  repoRoot: '/Users/me/my-project',
  base: 'a1b2c3d4',
  ahead: 2,
  ...patch,
})

describe('quotePath', () => {
  it('wraps a Unix path in single quotes, where nothing is special', () => {
    expect(quotePath('/Users/me/my project', 'darwin')).toBe("'/Users/me/my project'")
    expect(quotePath('/tmp/$HOME/`x`', 'linux')).toBe("'/tmp/$HOME/`x`'")
  })

  it('escapes a single quote inside a Unix path', () => {
    expect(quotePath("/tmp/it's here", 'linux')).toBe(`'/tmp/it'\\''s here'`)
  })

  it('wraps a Windows path in double quotes', () => {
    expect(quotePath('C:\\Users\\me\\my project', 'win32')).toBe('"C:\\Users\\me\\my project"')
  })

  it('cannot be made to end its quotes early', () => {
    expect(quotePath('C:\\a"; calc; "b', 'win32')).toBe('"C:\\a; calc; b"')
    // On Unix, the only character that ends the quotes is escaped away.
    const quoted = quotePath("x'; rm -rf ~; '", 'linux')
    expect(quoted.startsWith("'")).toBe(true)
    expect(quoted).toBe(`'x'\\''; rm -rf ~; '\\'''`)
  })
})

describe('mergeInstructions', () => {
  it('reads what is on the branch, then merges it, each naming the repository', () => {
    expect(mergeInstructions(info(), 'darwin')).toEqual([
      "git -C '/Users/me/my-project' log --oneline a1b2c3d4..shokuba/mission/abc-123",
      "git -C '/Users/me/my-project' diff a1b2c3d4...shokuba/mission/abc-123",
      "git -C '/Users/me/my-project' merge shokuba/mission/abc-123",
    ])
  })

  it('quotes for the person’s own shell', () => {
    const [first] = mergeInstructions(info({ repoRoot: 'C:\\Users\\me\\my project' }), 'win32')
    expect(first).toBe(
      'git -C "C:\\Users\\me\\my project" log --oneline a1b2c3d4..shokuba/mission/abc-123',
    )
  })
})

describe('branchSummary', () => {
  it('says how much accepted work is there', () => {
    expect(branchSummary(info({ ahead: 0 }))).toBe('nothing accepted yet, on top of a1b2c3d4')
    expect(branchSummary(info({ ahead: 1 }))).toBe('1 commit of accepted work, on top of a1b2c3d4')
    expect(branchSummary(info({ ahead: 3 }))).toBe('3 commits of accepted work, on top of a1b2c3d4')
  })
})
