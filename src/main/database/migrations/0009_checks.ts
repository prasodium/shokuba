import type { Migration } from '../migrator'

/**
 * Checks: commands a person defines per project, and the record of running them on a task's
 * work. Steps are the person's own words; a run stores a copy of each step as it ran, so a later
 * edit never rewrites what was verified. Output is redacted and capped before it is stored.
 *
 * `acknowledged_at` is when the person confirmed they understand these commands run agent-written
 * code with their access, unsandboxed. Nothing runs without it.
 */
export const checks: Migration = {
  id: 9,
  name: 'checks',
  sql: `
    CREATE TABLE project_checks_settings (
      repo_root       TEXT PRIMARY KEY,
      acknowledged_at TEXT,
      updated_at      TEXT NOT NULL
    );

    CREATE TABLE project_checks (
      id              TEXT PRIMARY KEY,
      repo_root       TEXT NOT NULL REFERENCES project_checks_settings (repo_root),
      position        INTEGER NOT NULL,
      kind            TEXT NOT NULL CHECK (kind IN ('setup', 'check')),
      name            TEXT NOT NULL,
      command         TEXT NOT NULL,
      timeout_seconds INTEGER NOT NULL,
      enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
    );
    CREATE INDEX idx_project_checks_repo ON project_checks (repo_root, position);

    CREATE TABLE check_runs (
      id          TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL REFERENCES tasks (id),
      mission_id  TEXT NOT NULL REFERENCES missions (id),
      repo_root   TEXT NOT NULL,
      commit_id   TEXT NOT NULL,
      trigger     TEXT NOT NULL CHECK (trigger IN ('auto', 'manual')),
      state       TEXT NOT NULL CHECK (state IN ('running', 'passed', 'failed', 'error', 'cancelled')),
      note        TEXT,
      started_at  TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX idx_check_runs_task ON check_runs (task_id, started_at);

    CREATE TABLE check_results (
      run_id      TEXT NOT NULL REFERENCES check_runs (id),
      position    INTEGER NOT NULL,
      kind        TEXT NOT NULL,
      name        TEXT NOT NULL,
      command     TEXT NOT NULL,
      state       TEXT NOT NULL CHECK (state IN ('passed', 'failed', 'timeout', 'skipped', 'error', 'cancelled')),
      exit_code   INTEGER,
      duration_ms INTEGER NOT NULL,
      output      TEXT NOT NULL,
      truncated   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, position)
    );
  `,
}
