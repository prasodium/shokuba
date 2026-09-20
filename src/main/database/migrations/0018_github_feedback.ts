import type { Migration } from '../migrator'

/**
 * What GitHub said that a task was made from: a check that failed on the pull request, or a
 * reviewer's request for changes. It is written by other people, so it is kept apart from the
 * task's own title and description (which are typed into an agent's terminal) and an agent reads it
 * only through the read-only issue tool, framed as untrusted data. One piece per task.
 */
export const githubFeedback: Migration = {
  id: 18,
  name: 'github_feedback',
  sql: `
    CREATE TABLE github_feedback (
      task_id    TEXT PRIMARY KEY REFERENCES tasks (id),
      mission_id TEXT NOT NULL REFERENCES missions (id),
      kind       TEXT NOT NULL CHECK (kind IN ('check', 'review')),
      author     TEXT,
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `,
}
