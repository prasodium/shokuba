import type { GitInfo } from '@shared/ipc/api'
import { GitError } from './runner'
import { MIN_GIT, type GitVersion } from './version'

/**
 * What to tell a person about the Git Shokuba found at startup. Asked again each time, so it says
 * what Git says now; only reads its version.
 */
export async function readGitInfo(
  git: { version(): Promise<GitVersion> } | undefined,
  problem: string | undefined,
): Promise<GitInfo> {
  const minimum = MIN_GIT.join('.')
  if (!git) return { state: 'unavailable', reason: problem ?? 'Git could not be used', minimum }
  try {
    return { state: 'ready', version: (await git.version()).text, minimum }
  } catch (error) {
    const reason = error instanceof GitError ? error.message : 'Git could not be used'
    return { state: 'unavailable', reason, minimum }
  }
}
