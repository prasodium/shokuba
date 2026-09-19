/** One file a task changed, as Git counts it. `added`/`deleted` are null for a binary file. */
export interface FileChange {
  path: string
  added: number | null
  deleted: number | null
  binary: boolean
}

/** One commit, as a record of who made it and when. */
export interface GitCommit {
  commit: string
  /** The name the commit was made under (the employee's, for a task's own commits). */
  author: string
  /** ISO 8601. */
  date: string
  /** True for a commit that joins two lines of history. */
  merge: boolean
  subject: string
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
      /** True once the task's working folder has been removed; the branch and this diff remain. */
      folderRemoved: boolean
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

/** Where a mission's accepted work is collecting, for the person to review and merge themselves. */
export interface MissionBranchInfo {
  branch: string
  /** The repository's folder name, and its full path for the commands to run there. */
  repoName: string
  repoRoot: string
  /** The commit the branch was cut from (short), and how many commits it is ahead of it. */
  base: string
  ahead: number
}
