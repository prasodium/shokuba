import type { Migration } from '../migrator'

/**
 * How an employee's little person looks (skin, hair, hair style, what they wear). It is stored as
 * JSON of ids from a fixed set, validated when it is written and read back tolerantly, so a value
 * that cannot be understood shows the default rather than breaking the office. The default is the
 * look every employee had before this existed, so nobody looks different until they are edited.
 */
export const appearance: Migration = {
  id: 11,
  name: 'appearance',
  sql: `
    ALTER TABLE employees ADD COLUMN appearance TEXT NOT NULL
      DEFAULT '{"skin":"sand","hair":"black","style":"short","accessory":"none"}';
  `,
}
