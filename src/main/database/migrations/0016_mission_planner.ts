import type { Migration } from '../migrator'

/**
 * Who a person has handed a draft mission to for planning. Only a manager can be handed one, and
 * only while it is a draft: it lets that manager add and remove the mission's tasks, as they can
 * for a draft they wrote themselves. Nothing else changes, and every mission made before this has
 * no planner.
 */
export const missionPlanner: Migration = {
  id: 16,
  name: 'mission_planner',
  sql: `
    ALTER TABLE missions ADD COLUMN planner_id TEXT REFERENCES employees (id);
  `,
}
