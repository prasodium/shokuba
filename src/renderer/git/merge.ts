import type { MissionBranchInfo } from '@shared/git'

type Platform = 'darwin' | 'win32' | 'linux'

/**
 * A path as it should be typed in a terminal. Shokuba only ever shows these commands; the person
 * runs them, so the quoting has to be right for their shell. Windows shells take double quotes
 * (and a path cannot contain one); the others take single quotes, in which nothing is special
 * except the quote itself.
 */
export function quotePath(path: string, platform: Platform): string {
  if (platform === 'win32') return `"${path.replace(/"/g, '')}"`
  return `'${path.replace(/'/g, `'\\''`)}'`
}

/**
 * The commands for reading and merging a mission's branch. Each one names the repository, so it
 * works from any folder. Merging is the person's to do: Shokuba never does it for them.
 */
export function mergeInstructions(branch: MissionBranchInfo, platform: Platform): string[] {
  const git = `git -C ${quotePath(branch.repoRoot, platform)}`
  return [
    `${git} log --oneline ${branch.base}..${branch.branch}`,
    `${git} diff ${branch.base}...${branch.branch}`,
    `${git} merge ${branch.branch}`,
  ]
}

/** One sentence on where the work has got to. */
export function branchSummary(branch: MissionBranchInfo): string {
  const commits =
    branch.ahead === 0
      ? 'nothing accepted yet'
      : `${branch.ahead} ${branch.ahead === 1 ? 'commit' : 'commits'} of accepted work`
  return `${commits}, on top of ${branch.base}`
}
