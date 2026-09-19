import type { Migration } from '../migrator'

/**
 * Missions and their task graph. Tasks depend on other tasks (a real graph, not a flat
 * list). A task is assigned to an employee, and its status says how far an agent's claim
 * has been accepted: `submitted` is what the agent says, `done` is what a person accepted.
 */
export const missions: Migration = {
  id: 3,
  name: 'missions',
  sql: `
    CREATE TABLE missions (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'running', 'paused', 'completed', 'cancelled')),
      priority    TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE INDEX idx_missions_active ON missions (archived_at, created_at);

    CREATE TABLE tasks (
      id             TEXT PRIMARY KEY,
      mission_id     TEXT NOT NULL REFERENCES missions (id),
      title          TEXT NOT NULL,
      description    TEXT NOT NULL DEFAULT '',
      status         TEXT NOT NULL CHECK (status IN (
                       'pending', 'ready', 'in_progress', 'submitted',
                       'changes_requested', 'blocked', 'done', 'cancelled')),
      assignee_id    TEXT REFERENCES employees (id),
      priority       TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
      attempts       INTEGER NOT NULL DEFAULT 0,
      summary        TEXT,
      blocked_reason TEXT,
      review_note    TEXT,
      position       INTEGER NOT NULL,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      started_at     TEXT,
      submitted_at   TEXT,
      completed_at   TEXT
    );
    CREATE INDEX idx_tasks_mission  ON tasks (mission_id, position);
    CREATE INDEX idx_tasks_assignee ON tasks (assignee_id, status);

    CREATE TABLE task_dependencies (
      task_id       TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
      depends_on_id TEXT NOT NULL REFERENCES tasks (id),
      PRIMARY KEY (task_id, depends_on_id),
      CHECK (task_id != depends_on_id)
    );
    CREATE INDEX idx_task_dependencies_on ON task_dependencies (depends_on_id);
  `,
}
