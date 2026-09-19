import type { Migration } from '../migrator'

/**
 * Who drafted a mission. Null means the person did; otherwise it is the manager whose agent
 * drafted it, which is what limits a manager to editing its own drafts and lets the person see
 * that a plan came from an agent before running it.
 */
export const missionAuthors: Migration = {
  id: 6,
  name: 'mission-authors',
  sql: `
    ALTER TABLE missions ADD COLUMN created_by TEXT REFERENCES employees (id);
  `,
}
