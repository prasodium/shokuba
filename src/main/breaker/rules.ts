import { levelRank, type BreakerLevel, type BreakerRule } from '@shared/breaker'

/**
 * How many of each signal it takes to raise an agent's level. These are deliberate defaults,
 * kept in one place. A rule with no `pause` step never pauses an agent by itself: a long turn
 * or a halted conversation is a reason to look, not evidence of a runaway.
 */
export interface Ladder {
  warning: number
  constrain: number
  pause?: number
}

export const THRESHOLDS = {
  /** The same call (tool and short summary), one after another with nothing between. */
  repeatedCalls: { warning: 5, constrain: 8, pause: 12 },
  /** Tool calls that failed, one after another. */
  failedCalls: { warning: 6, constrain: 10, pause: 15 },
  /** Turns that ended in an error, within `windowMs`. */
  failedTurns: { warning: 2, constrain: 3, pause: 5, windowMs: 10 * 60_000 },
  /** Different files edited in the current task. */
  fileChanges: { warning: 40, constrain: 80, pause: 150 },
  /** How long a single turn has been running, in ms. Never pauses on its own. */
  longTurn: { warning: 30 * 60_000, constrain: 90 * 60_000 },
  /** Conversations involving the agent that were halted, within `windowMs`. */
  haltedConversations: { warning: 1, constrain: 2, windowMs: 30 * 60_000 },
  /** How long a warning lasts once nothing more trips. */
  warningClearsAfterMs: 10 * 60_000,
} as const

export function levelFor(value: number, ladder: Ladder): BreakerLevel {
  if (ladder.pause !== undefined && value >= ladder.pause) return 'pause'
  if (value >= ladder.constrain) return 'constrain'
  if (value >= ladder.warning) return 'warning'
  return 'normal'
}

/** A rule that has been tripped, and how far. */
export interface Finding {
  rule: BreakerRule
  level: BreakerLevel
  /** A sentence saying what happened. */
  detail: string
  /** For `repeated-call`: which call is being repeated, so that call (and only it) can be denied. */
  callKey?: string
}

const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export function isEditTool(toolName: string): boolean {
  return EDIT_TOOLS.has(toolName)
}

/** The key that makes two calls "the same": the tool and its short summary. */
export function callKey(toolName: string, summary: string): string {
  return `${toolName}|${summary}`
}

const MAX_TRACKED_FILES = 5_000

/**
 * What one agent has been doing, boiled down to the counts the rules look at. Pure: it is fed
 * events and asked what, if anything, has been tripped. It knows nothing about processes or
 * the database, so every rule is tested on its own.
 *
 * "The same call" means the same tool with the same short summary (for example "Run npm test"),
 * not byte-identical arguments; that is what an event records.
 */
export class AgentMeter {
  private repeat: { key: string; label: string; count: number } | null = null
  private failedInRow = 0
  private failedTurns: number[] = []
  private files = new Set<string>()
  private turnStartedAt: number | null = null
  private halts: number[] = []

  toolStarted(toolName: string, summary: string): void {
    const key = callKey(toolName, summary)
    this.repeat =
      this.repeat?.key === key
        ? { ...this.repeat, count: this.repeat.count + 1 }
        : { key, label: summary || toolName, count: 1 }
    if (isEditTool(toolName) && this.files.size < MAX_TRACKED_FILES) {
      const file = summary.replace(/^Edit\s+/, '').trim()
      if (file.length > 0) this.files.add(file)
    }
  }

  toolFinished(ok: boolean): void {
    this.failedInRow = ok ? 0 : this.failedInRow + 1
  }

  /** How many times in a row this exact call has just been made (0 if the latest call was different). */
  repeatCount(key: string): number {
    return this.repeat?.key === key ? this.repeat.count : 0
  }

  /** How many different files have been edited in the current task. */
  editedFileCount(): number {
    return this.files.size
  }

  turnStarted(now: number): void {
    this.turnStartedAt = now
  }

  turnFinished(): void {
    this.turnStartedAt = null
  }

  turnFailed(now: number): void {
    this.failedTurns.push(now)
  }

  conversationHalted(now: number): void {
    this.halts.push(now)
  }

  /** A new task was handed over: files edited so far belong to the last one. */
  taskStarted(): void {
    this.files.clear()
  }

  reset(): void {
    this.repeat = null
    this.failedInRow = 0
    this.failedTurns = []
    this.files.clear()
    this.turnStartedAt = null
    this.halts = []
  }

  /** The most serious thing tripped right now, or null. */
  assess(now: number): Finding | null {
    this.failedTurns = this.failedTurns.filter((t) => now - t < THRESHOLDS.failedTurns.windowMs)
    this.halts = this.halts.filter((t) => now - t < THRESHOLDS.haltedConversations.windowMs)

    const findings: Finding[] = []
    const add = (rule: BreakerRule, level: BreakerLevel, detail: string, key?: string): void => {
      if (level !== 'normal')
        findings.push({ rule, level, detail, ...(key !== undefined && { callKey: key }) })
    }

    if (this.repeat) {
      add(
        'repeated-call',
        levelFor(this.repeat.count, THRESHOLDS.repeatedCalls),
        `the same call (${this.repeat.label}) ${this.repeat.count} times in a row`,
        this.repeat.key,
      )
    }
    add(
      'failed-calls',
      levelFor(this.failedInRow, THRESHOLDS.failedCalls),
      `${this.failedInRow} tool calls failed in a row`,
    )
    add(
      'failed-turns',
      levelFor(this.failedTurns.length, THRESHOLDS.failedTurns),
      `${this.failedTurns.length} turns ended in an error in the last 10 minutes`,
    )
    add(
      'file-changes',
      levelFor(this.files.size, THRESHOLDS.fileChanges),
      `${this.files.size} different files edited in this task`,
    )
    if (this.turnStartedAt !== null) {
      const elapsed = now - this.turnStartedAt
      add(
        'long-turn',
        levelFor(elapsed, THRESHOLDS.longTurn),
        `one turn has been running for ${Math.floor(elapsed / 60_000)} minutes`,
      )
    }
    add(
      'halted-conversations',
      levelFor(this.halts.length, THRESHOLDS.haltedConversations),
      `${this.halts.length} of its conversations were stopped as possible loops`,
    )

    return findings.reduce<Finding | null>(
      (worst, next) =>
        worst === null || levelRank(next.level) > levelRank(worst.level) ? next : worst,
      null,
    )
  }
}
