import type { Migration } from '../migrator'

/**
 * Where a mission came from on GitHub. A mission made from an issue keeps a link to it: which
 * repository, which issue, and the issue's own title, author and text as they were when it was
 * imported (all of it written by other people, so it is kept apart from the mission's own
 * description and always shown as untrusted). The pull request that answers it is added to the
 * same row later.
 *
 * Not unique on the issue: a mission that was archived may be imported again, so the rule
 * "one live mission per issue" is kept by the service, not the table.
 */
export const githubLinks: Migration = {
  id: 15,
  name: 'github_links',
  sql: `
    CREATE TABLE github_links (
      mission_id   TEXT PRIMARY KEY REFERENCES missions (id),
      owner        TEXT NOT NULL,
      repo         TEXT NOT NULL,
      repo_root    TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      issue_title  TEXT NOT NULL,
      issue_url    TEXT NOT NULL,
      issue_author TEXT,
      issue_body   TEXT NOT NULL,
      imported_at  TEXT NOT NULL
    );
    CREATE INDEX idx_github_links_issue ON github_links (owner, repo, issue_number);
  `,
}
