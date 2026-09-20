import type { Migration } from '../migrator'

/**
 * Roles: starting points for hiring, which the person can edit. Shokuba's own four are stored here
 * too (they are put in when the app starts, so what they say can be reset to the original that
 * lives in the code), marked with `builtin_id`. An employee keeps their own copy of what a role
 * said when they were hired, so nothing here points at an employee and no employee points here.
 */
export const roles: Migration = {
  id: 12,
  name: 'roles',
  sql: `
    CREATE TABLE roles (
      id              TEXT PRIMARY KEY,
      label           TEXT NOT NULL,
      is_manager      INTEGER NOT NULL DEFAULT 0 CHECK (is_manager IN (0, 1)),
      instructions    TEXT NOT NULL DEFAULT '',
      permission_mode TEXT NOT NULL DEFAULT 'default'
                      CHECK (permission_mode IN ('default', 'acceptEdits', 'plan')),
      builtin_id      TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      archived_at     TEXT
    );
    CREATE INDEX idx_roles_active ON roles (archived_at, created_at);
  `,
}
