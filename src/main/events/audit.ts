import type { Db } from '../database/connection'
import { redactDeep } from '../security/redact'

export interface AuditEntry {
  /** Who did it: "system", "user", or an employee id. */
  actor: string
  /** Dotted verb, e.g. "app.start", "approval.granted". */
  action: string
  target?: string
  detail?: Record<string, unknown>
}

export interface AuditRecord {
  seq: number
  ts: string
  actor: string
  action: string
  target: string | null
  detail: Record<string, unknown>
}

/** Append-only record of security-relevant actions. Separate from the event feed. */
export class AuditLog {
  private readonly insert

  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.insert = db.prepare(
      'INSERT INTO audit_log (ts, actor, action, target, detail) VALUES (@ts, @actor, @action, @target, @detail)',
    )
  }

  record(entry: AuditEntry): number {
    if (entry.actor.length === 0 || entry.action.length === 0) {
      throw new Error('Audit entries need a non-empty actor and action')
    }
    const info = this.insert.run({
      ts: this.now().toISOString(),
      actor: entry.actor,
      action: entry.action,
      target: entry.target ?? null,
      detail: JSON.stringify(redactDeep(entry.detail ?? {})),
    })
    return Number(info.lastInsertRowid)
  }

  list(afterSeq = 0, limit = 100): AuditRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_log WHERE seq > ? ORDER BY seq ASC LIMIT ?')
      .all(afterSeq, limit) as (Omit<AuditRecord, 'detail'> & { detail: string })[]
    return rows.map((row) => ({
      ...row,
      detail: JSON.parse(row.detail) as Record<string, unknown>,
    }))
  }
}
