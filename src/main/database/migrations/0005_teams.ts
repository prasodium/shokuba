import type { Migration } from '../migrator'

/**
 * Teams. An employee is either a manager (who talks to the person) or reports to one. A team is
 * a manager and the people who report to them, so there is no separate table for it: it would
 * only be a second place to keep the same fact. `instructions` is the editable text that says
 * what this employee's role is for, on top of the one-word `role`.
 */
export const teams: Migration = {
  id: 5,
  name: 'teams',
  sql: `
    ALTER TABLE employees ADD COLUMN is_manager   INTEGER NOT NULL DEFAULT 0 CHECK (is_manager IN (0, 1));
    ALTER TABLE employees ADD COLUMN reports_to   TEXT REFERENCES employees (id);
    ALTER TABLE employees ADD COLUMN instructions TEXT;
    CREATE INDEX idx_employees_reports_to ON employees (reports_to);
  `,
}
