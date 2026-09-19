import type { FileChange } from '@shared/git'

export type DiffLineKind = 'add' | 'remove' | 'hunk' | 'meta' | 'context'

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

/**
 * Sort the lines of a Git diff so the app can colour them. The diff is shown as text and never
 * as markup, so nothing in a file can become part of the page.
 */
export function classifyDiff(diff: string): DiffLine[] {
  if (diff.length === 0) return []
  return diff
    .replace(/\r?\n$/, '')
    .split(/\r?\n/)
    .map((text): DiffLine => {
      if (text.startsWith('+++') || text.startsWith('---')) return { kind: 'meta', text }
      if (
        text.startsWith('diff --git') ||
        text.startsWith('index ') ||
        text.startsWith('new file') ||
        text.startsWith('deleted file') ||
        text.startsWith('old mode') ||
        text.startsWith('new mode') ||
        text.startsWith('Binary files')
      ) {
        return { kind: 'meta', text }
      }
      if (text.startsWith('@@')) return { kind: 'hunk', text }
      if (text.startsWith('+')) return { kind: 'add', text }
      if (text.startsWith('-')) return { kind: 'remove', text }
      return { kind: 'context', text }
    })
}

/** "3 files, +12 −4", or "no changes". */
export function summarizeChanges(files: readonly FileChange[]): string {
  if (files.length === 0) return 'no changes'
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0)
  const removed = files.reduce((sum, file) => sum + (file.deleted ?? 0), 0)
  return `${files.length} ${files.length === 1 ? 'file' : 'files'}, +${added} −${removed}`
}

/** One file's line count as shown beside its name: "+3 −1", or "binary". */
export function fileCounts(file: FileChange): string {
  return file.binary ? 'binary' : `+${file.added ?? 0} −${file.deleted ?? 0}`
}
