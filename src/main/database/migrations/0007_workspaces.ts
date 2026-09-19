import type { Migration } from '../migrator'

/**
 * Where a task's work happens. A mission gets one branch per repository (the branch accepted
 * work collects on), and each task gets a working folder on its own branch.
 *
 * `state` of a task's workspace: `active` (its folder and branch exist), `merged` (accepted
 * into the mission branch), `none` (the task ran without isolation, and `note` says why), and
 * `removed` (the folder is gone; the branch stays). Paths and commit ids are facts about
 * Git, never text an agent wrote.
 */
export const workspaces: Migration = {
  id: 7,
  name: 'workspaces',
  sql: `
    CREATE TABLE mission_branches (
      mission_id  TEXT NOT NULL REFERENCES missions (id),
      repo_root   TEXT NOT NULL,
      branch      TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (mission_id, repo_root)
    );

    CREATE TABLE task_workspaces (
      task_id       TEXT PRIMARY KEY REFERENCES tasks (id),
      mission_id    TEXT NOT NULL REFERENCES missions (id),
      state         TEXT NOT NULL CHECK (state IN ('active', 'merged', 'none', 'removed')),
      repo_root     TEXT,
      branch        TEXT,
      worktree_path TEXT,
      base_commit   TEXT,
      head_commit   TEXT,
      merge_commit  TEXT,
      note          TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX idx_task_workspaces_mission ON task_workspaces (mission_id);
  `,
}
