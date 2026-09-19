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
