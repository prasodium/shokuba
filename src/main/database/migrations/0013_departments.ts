import type { Migration } from '../migrator'

/**
 * Departments: named, coloured groups of people, which decide where people sit in the office and how
 * the roster lists them. An employee is in at most one (none is fine), and removing a department
 * takes its people out of it rather than removing anyone. It is not a team: who reports to whom is
 * a different fact, kept where it always was.
 */
export const departments: Migration = {
  id: 13,
  name: 'departments',
  sql: `
    CREATE TABLE departments (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      color       TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE INDEX idx_departments_active ON departments (archived_at, created_at);

    ALTER TABLE employees ADD COLUMN department_id TEXT REFERENCES departments (id);
    CREATE INDEX idx_employees_department ON employees (department_id);
  `,
}
