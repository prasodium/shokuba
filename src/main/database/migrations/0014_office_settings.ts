import type { Migration } from '../migrator'

/**
 * How the person has dressed the office: its name, floors, walls, windows, plants and the names of
 * the shared places. It is one row of JSON (there is only one office), validated when it is written
 * and read back tolerantly, so a value that cannot be understood shows the office as it has always
 * looked rather than breaking it. No row means the defaults.
 */
export const officeSettings: Migration = {
  id: 14,
  name: 'office_settings',
  sql: `
    CREATE TABLE office_settings (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      data       TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
}
