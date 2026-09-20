import type { PullOpenResult, PullPreview, PullRequestRecord } from '@shared/github'

/** Whether the person may be offered the button: nothing is in the way. */
export function canOpen(preview: Pick<PullPreview, 'problems'>): boolean {
  return preview.problems.length === 0
}

/** What the button says: what it will do, and never less than that. */
export function openLabel(preview: Pick<PullPreview, 'existing'>): string {
  return preview.existing
    ? `Push the new commits to #${preview.existing.number}`
    : 'Push the branch and open the pull request'
}

/** The sentence that says what a click will do, so nothing happens that was not said first. */
export function willDo(
  preview: Pick<PullPreview, 'branch' | 'repo' | 'login' | 'base' | 'existing'>,
  draft: boolean,
): string {
  const push = `This pushes ${preview.branch} to GitHub using your own Git setup`
  const open = preview.existing
    ? `and adds the new commits to pull request #${preview.existing.number}`
    : `and opens ${draft ? 'a draft ' : 'a '}pull request in ${preview.repo}, into ${preview.base}, as ${preview.login}`
  return `${push}, ${open}. It never merges anything, and never comments on the issue.`
}

/** What was done, in a sentence. */
export function resultLine(result: Pick<PullOpenResult, 'number' | 'draft' | 'existing'>): string {
  if (result.existing) return `Pushed the new commits to pull request #${result.number}.`
  return `Opened ${result.draft ? 'draft ' : ''}pull request #${result.number}.`
}

/** How a mission's recorded pull request reads next to it. */
export function recordLine(pr: Pick<PullRequestRecord, 'number' | 'draft'>, repo: string): string {
  return `Pull request #${pr.number} in ${repo}${pr.draft ? ' (draft)' : ''}`
}
