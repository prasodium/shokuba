import type { Employee, PermissionMode } from '@shared/employees'
import type { EventSource } from '@shared/events/schema'
import type { Env, PlatformId } from '../platform'

/**
 * A provider adapter teaches Shokuba about one kind of CLI agent: how to find it, how to
 * launch it, and how to understand what it reports. It does NOT own the process. The
 * runtime starts every agent in a PTY the same way, so terminals, interrupts, resizing
 * and shutdown behave identically for every provider — the adapter only describes the
 * differences.
 */
export interface ProviderAdapter {
  readonly id: string
  readonly displayName: string
  readonly capabilities: ProviderCapabilities
  readonly observation: ObservationChannel
  detect(context: DetectContext): Promise<ProviderInstallation>
  /** Pure: describe the launch, do no I/O. The runtime writes `files` and spawns. */
  buildLaunch(input: LaunchInput): LaunchSpec
}

export interface ProviderCapabilities {
  /** Everything this provider reports is demo data rather than a real agent. */
  simulated: boolean
  supportsModelSelection: boolean
  permissionModes: readonly PermissionMode[]
}

export interface DetectContext {
  platform: PlatformId
  env: Env
  home: string
}

export interface ProviderInstallation {
  found: boolean
  path: string | null
  version: string | null
  /** Human-readable reason the provider cannot be launched, or null when it can. */
  problem: string | null
}

export interface LaunchInput {
  platform: PlatformId
  /** Shokuba's own environment, read-only: for deciding which of its variables to inherit. */
  env: Env
  employee: Pick<Employee, 'id' | 'name' | 'role' | 'workingDirectory' | 'model' | 'permissionMode'>
  /** Absolute path to the executable, from `detect`. */
  executable: string
  /** Where the agent reports what it is doing. The token itself is only ever in the env. */
  report: { url: string; tokenEnvVar: string }
  /** A directory Shokuba owns for this agent's generated files. */
  runDir: string
}

export interface LaunchSpec {
  file: string
  args: string[]
  /** Added on top of the allow-listed base environment. */
  env: Record<string, string>
  /**
   * Names of variables to copy from Shokuba's environment because *this provider* needs them
   * (its own credentials, proxy settings). Everything else stays filtered out, so a
   * credential meant for another tool is never handed to an agent by accident.
   */
  inheritEnv?: readonly string[]
  /** Written (owner-only) into `runDir` before launch. `name` is a plain file name. */
  files: Array<{ name: string; content: string }>
}

/**
 * Provider-neutral facts about what an agent is doing. Each adapter translates its own
 * signals (Claude Code hooks, another CLI's structured output...) into these, so the
 * state tracker, events and office never learn provider details.
 */
export type AgentSignal =
  | { kind: 'session-started' }
  | { kind: 'turn-started' }
  | {
      kind: 'tool-started'
      toolUseId?: string
      toolName: string
      summary: string
      /** The activity this tool implies, and whether that is our guess rather than a fact. */
      activity: ToolActivity
    }
  | {
      kind: 'tool-finished'
      toolUseId?: string
      toolName: string
      ok: boolean
      durationMs?: number
    }
  | { kind: 'attention'; reason: 'permission' | 'input' | 'other'; message: string }
  | { kind: 'turn-finished' }
  | { kind: 'turn-failed'; message: string }
  | { kind: 'session-ended'; reason: string }

export interface ToolActivity {
  state: 'thinking' | 'coding' | 'testing' | 'researching'
  /** true when the state comes from our classification (e.g. a Bash command that looks like a test run). */
  inferred: boolean
}

export interface ObservationChannel {
  readonly kind: 'hooks' | 'simulated'
  /** How events produced from this channel are labelled in the log. */
  readonly source: Extract<EventSource, 'reported' | 'simulated'>
  /** Translate one raw report. Unknown or malformed input yields no signals, never a throw. */
  parse(raw: unknown): AgentSignal[]
}
