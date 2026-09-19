import type { Migration } from '../migrator'

/**
 * Employees: the persistent identity of an agent. The running process is separate and
 * ephemeral (an employee can be offline); this table is what survives a restart.
 * Archiving is a soft delete, because events in the log refer to employees by id.
 */
export const employees: Migration = {
  id: 2,
  name: 'employees',
  sql: `
    CREATE TABLE employees (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      role              TEXT NOT NULL,
      provider_id       TEXT NOT NULL,
      working_directory TEXT NOT NULL,
      model             TEXT,
      permission_mode   TEXT NOT NULL DEFAULT 'default'
                        CHECK (permission_mode IN ('default', 'acceptEdits', 'plan')),
      color             TEXT NOT NULL DEFAULT '#e8893a',
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      archived_at       TEXT
    );
    CREATE INDEX idx_employees_active ON employees (archived_at, created_at);
  `,
}
