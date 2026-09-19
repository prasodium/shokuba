import type { Migration } from '../migrator'

/**
 * Independent reviews of a task's work. A review is its own record, not a task: it must not
 * appear in the mission's graph or count towards a mission being finished. It names the exact
 * commit that was reviewed, so a review of an earlier version is never mistaken for the latest.
 *
 * `review_settings` says who reviews a project's work and whether one is asked for automatically.
 * Findings are the reviewer's own words, stored as text and never followed or opened.
 */
export const reviews: Migration = {
  id: 10,
  name: 'reviews',
  sql: `
    CREATE TABLE review_settings (
      repo_root   TEXT PRIMARY KEY,
      reviewer_id TEXT REFERENCES employees (id),
      auto        INTEGER NOT NULL DEFAULT 0 CHECK (auto IN (0, 1)),
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE reviews (
      id            TEXT PRIMARY KEY,
      task_id       TEXT NOT NULL REFERENCES tasks (id),
      mission_id    TEXT NOT NULL REFERENCES missions (id),
      reviewer_id   TEXT NOT NULL REFERENCES employees (id),
      repo_root     TEXT NOT NULL,
      commit_id     TEXT NOT NULL,
      base_commit   TEXT NOT NULL,
      state         TEXT NOT NULL CHECK (state IN ('queued', 'in_progress', 'submitted', 'cancelled', 'error')),
      verdict       TEXT CHECK (verdict IN ('approve', 'request_changes', 'comment')),
      summary       TEXT,
      requested_by  TEXT NOT NULL CHECK (requested_by IN ('auto', 'manual')),
      worktree_path TEXT,
      note          TEXT,
      folder_removed_at TEXT,
      created_at    TEXT NOT NULL,
      started_at    TEXT,
      submitted_at  TEXT
    );
    CREATE INDEX idx_reviews_task ON reviews (task_id, created_at);
    CREATE INDEX idx_reviews_reviewer ON reviews (reviewer_id, state);

    CREATE TABLE review_findings (
      review_id TEXT NOT NULL REFERENCES reviews (id),
      position  INTEGER NOT NULL,
      severity  TEXT NOT NULL CHECK (severity IN ('blocker', 'major', 'minor', 'nit')),
      file      TEXT,
      line      INTEGER,
      note      TEXT NOT NULL,
      PRIMARY KEY (review_id, position)
    );
  `,
}
