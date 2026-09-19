import type { Migration } from '../migrator'

/**
 * When a task's working folder was removed. The task's branch stays, so its work can still be
 * reviewed; only the folder goes, once the task is finished and no agent is working in it.
 */
export const workspaceRemoval: Migration = {
  id: 8,
  name: 'workspace-removal',
  sql: `
    ALTER TABLE task_workspaces ADD COLUMN removed_at TEXT;
  `,
}
