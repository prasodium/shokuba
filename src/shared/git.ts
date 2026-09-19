/** One file a task changed, as Git counts it. `added`/`deleted` are null for a binary file. */
export interface FileChange {
  path: string
  added: number | null
  deleted: number | null
  binary: boolean
}

/** Where a repository is right now: the commit checked out, and its branch if it has one. */
export interface HeadInfo {
  commit: string
  branch: string | null
}

/** What merging one Shokuba branch into another did. A conflict changes nothing. */
export type MergeOutcome =
  | { kind: 'merged'; commit: string }
  | { kind: 'up-to-date' }
  | { kind: 'conflict'; files: string[] }

/**
 * What a task changed, for review. A task that ran without isolation has no branch to show, and
 * `reason` says why (or is null if it has not been handed out yet).
 */
export type TaskChanges =
  | { isolated: false; reason: string | null }
  | {
      isolated: true
      branch: string
      /** `active`: still being worked on or awaiting review. `merged`: accepted into the mission branch. */
      state: 'active' | 'merged'
      files: FileChange[]
      /** The changes as text, cut off at a size the app can show. */
      diff: string
      truncated: boolean
      /** Something worth telling the person, such as work that could not be committed. */
      note: string | null
    }

/** How a note Shokuba wrote itself (not the person) begins when a task is sent back over a conflict. */
export const CONFLICT_NOTE_PREFIX = 'Your work could not be accepted yet:'

export function isConflictNote(note: string | null): boolean {
  return note !== null && note.startsWith(CONFLICT_NOTE_PREFIX)
}
