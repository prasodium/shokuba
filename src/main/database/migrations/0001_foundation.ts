import type { Migration } from '../migrator'

/**
 * Foundation: the event log (single source of truth for everything the office shows)
 * and the audit log. Both are append-only — enforced by triggers, not convention — so
 * a replay of history is always a replay of what actually happened.
 */
export const foundation: Migration = {
  id: 1,
  name: 'foundation',
  sql: `
    CREATE TABLE agent_events (
      seq            INTEGER PRIMARY KEY AUTOINCREMENT,
      id             TEXT NOT NULL UNIQUE,
      ts             TEXT NOT NULL,
      type           TEXT NOT NULL,
      source         TEXT NOT NULL,
      actor_id       TEXT,
      target_id      TEXT,
      mission_id     TEXT,
      task_id        TEXT,
      correlation_id TEXT,
      causation_id   TEXT,
      payload        TEXT NOT NULL CHECK (json_valid(payload))
    );
    CREATE INDEX idx_agent_events_type    ON agent_events (type, seq);
    CREATE INDEX idx_agent_events_actor   ON agent_events (actor_id, seq);
    CREATE INDEX idx_agent_events_task    ON agent_events (task_id, seq);
    CREATE INDEX idx_agent_events_mission ON agent_events (mission_id, seq);

    CREATE TRIGGER agent_events_no_update BEFORE UPDATE ON agent_events
    BEGIN SELECT RAISE(ABORT, 'agent_events is append-only'); END;
    CREATE TRIGGER agent_events_no_delete BEFORE DELETE ON agent_events
    BEGIN SELECT RAISE(ABORT, 'agent_events is append-only'); END;

    CREATE TABLE audit_log (
      seq    INTEGER PRIMARY KEY AUTOINCREMENT,
      ts     TEXT NOT NULL,
      actor  TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail))
    );
    CREATE INDEX idx_audit_log_action ON audit_log (action, seq);

    CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `,
}
