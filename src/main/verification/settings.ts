import { randomUUID } from 'node:crypto'
import {
  CheckSettingsSaveSchema,
  type CheckSettings,
  type CheckSettingsSave,
  type CheckStep,
} from '@shared/verification'
import type { Db } from '../database/connection'

export type CheckErrorCode = 'invalid' | 'unknown-repo'

export class CheckError extends Error {
  constructor(
    readonly code: CheckErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CheckError'
  }
}

interface StepRow {
  id: string
  kind: 'setup' | 'check'
  name: string
  command: string
  timeout_seconds: number
  enabled: number
}

/**
 * The commands a person has chosen to run on a project's work. They are stored here, in
 * Shokuba's own database, and nowhere else: never read from the repository, so nothing an
 * agent writes can add a command or weaken one. Nothing runs until the person has said, in
 * so many words, that they understand these run agent-written code with their own access.
 */
export class CheckSettingsStore {
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(private readonly deps: { db: Db; now?: () => Date; newId?: () => string }) {
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? randomUUID
  }

  get(repoRoot: string): CheckSettings {
    const settings = this.deps.db
      .prepare('SELECT acknowledged_at FROM project_checks_settings WHERE repo_root = ?')
      .get(repoRoot) as { acknowledged_at: string | null } | undefined
    const rows = this.deps.db
      .prepare('SELECT * FROM project_checks WHERE repo_root = ? ORDER BY position')
      .all(repoRoot) as StepRow[]
    return {
      repoRoot,
      acknowledged: settings?.acknowledged_at != null,
      steps: rows.map(toStep),
    }
  }

  save(raw: CheckSettingsSave): CheckSettings {
    const parsed = CheckSettingsSaveSchema.safeParse(raw)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const where = issue?.path.map(String).join('.')
      throw new CheckError(
        'invalid',
        where ? `${where}: ${issue?.message}` : (issue?.message ?? 'Invalid checks'),
      )
    }
    const { repoRoot, acknowledged, steps } = parsed.data

    const names = new Set<string>()
    for (const step of steps) {
      const key = step.name.toLowerCase()
      if (names.has(key)) throw new CheckError('invalid', `Two steps are called "${step.name}"`)
      names.add(key)
    }

    const ts = this.now().toISOString()
    const before = this.deps.db
      .prepare('SELECT acknowledged_at FROM project_checks_settings WHERE repo_root = ?')
      .get(repoRoot) as { acknowledged_at: string | null } | undefined
    // The moment of acknowledging is kept as it was, so it says when the person first agreed.
    const acknowledgedAt = acknowledged ? (before?.acknowledged_at ?? ts) : null

    this.deps.db.transaction(() => {
      this.deps.db
        .prepare(
          `INSERT INTO project_checks_settings (repo_root, acknowledged_at, updated_at)
           VALUES (@repoRoot, @acknowledgedAt, @ts)
           ON CONFLICT (repo_root) DO UPDATE SET acknowledged_at = @acknowledgedAt, updated_at = @ts`,
        )
        .run({ repoRoot, acknowledgedAt, ts })
      this.deps.db.prepare('DELETE FROM project_checks WHERE repo_root = ?').run(repoRoot)
      const insert = this.deps.db.prepare(
        `INSERT INTO project_checks (id, repo_root, position, kind, name, command, timeout_seconds, enabled)
         VALUES (@id, @repoRoot, @position, @kind, @name, @command, @timeoutSeconds, @enabled)`,
      )
      steps.forEach((step, position) => {
        insert.run({
          id: this.newId(),
          repoRoot,
          position,
          kind: step.kind,
          name: step.name,
          command: step.command,
          timeoutSeconds: step.timeoutSeconds,
          enabled: step.enabled ? 1 : 0,
        })
      })
    })()
    return this.get(repoRoot)
  }

  /** Whether checks will run on this project's work: acknowledged, with at least one enabled check. */
  isReady(repoRoot: string): boolean {
    const settings = this.get(repoRoot)
    return settings.acknowledged && settings.steps.some((s) => s.enabled && s.kind === 'check')
  }

  /**
   * The steps to run, in order: setup steps first (they are what the checks need), then the
   * checks, each group in the order the person listed them. Empty unless checks are ready.
   */
  stepsToRun(repoRoot: string): CheckStep[] {
    if (!this.isReady(repoRoot)) return []
    const enabled = this.get(repoRoot).steps.filter((step) => step.enabled)
    return [
      ...enabled.filter((s) => s.kind === 'setup'),
      ...enabled.filter((s) => s.kind === 'check'),
    ]
  }
}

function toStep(row: StepRow): CheckStep {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    command: row.command,
    timeoutSeconds: row.timeout_seconds,
    enabled: row.enabled === 1,
  }
}
