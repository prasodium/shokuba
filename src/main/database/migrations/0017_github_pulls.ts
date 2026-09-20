import type { Migration } from '../migrator'

/**
 * The pull request Shokuba opened for a mission that came from an issue: which one, whether it was
 * opened as a draft, when, and the commit that was pushed for it. Every mission made before this has
 * none, and the address of the pull request is made from the repository and number, not stored.
 */
export const githubPulls: Migration = {
  id: 17,
  name: 'github_pulls',
  sql: `
    ALTER TABLE github_links ADD COLUMN pr_number INTEGER;
    ALTER TABLE github_links ADD COLUMN pr_draft INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE github_links ADD COLUMN pr_opened_at TEXT;
    ALTER TABLE github_links ADD COLUMN pr_head TEXT;
  `,
}
