import type { Migration } from '../migrator'

/**
 * Messages between employees (and the person). Each row is one message to one recipient, so
 * delivery state is per recipient. `hop` is the message's place in a chain of replies, which is
 * what loop protection counts. `from_id` / `to_id` are an employee id or the literal 'human',
 * so they are not foreign keys.
 */
export const messages: Migration = {
  id: 4,
  name: 'messages',
  sql: `
    CREATE TABLE conversations (
      id            TEXT PRIMARY KEY,
      subject       TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'halted', 'closed')),
      halted_reason TEXT,
      mission_id    TEXT REFERENCES missions (id),
      hop_base      INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX idx_conversations_recent ON conversations (updated_at);

    CREATE TABLE messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations (id),
      parent_id       TEXT REFERENCES messages (id),
      hop             INTEGER NOT NULL CHECK (hop >= 1),
      from_id         TEXT NOT NULL,
      to_id           TEXT NOT NULL,
      kind            TEXT NOT NULL CHECK (kind IN (
                        'request', 'inform', 'question', 'handoff',
                        'review', 'approval', 'warning', 'completion')),
      subject         TEXT NOT NULL,
      body            TEXT NOT NULL,
      task_id         TEXT REFERENCES tasks (id),
      state           TEXT NOT NULL CHECK (state IN ('queued', 'delivered', 'held')),
      held_reason     TEXT,
      created_at      TEXT NOT NULL,
      delivered_at    TEXT,
      read_at         TEXT
    );
    CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at);
    CREATE INDEX idx_messages_inbox        ON messages (to_id, state, created_at);
  `,
}
