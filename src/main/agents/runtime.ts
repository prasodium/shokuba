import { execFile } from 'node:child_process'
import { constants as osConstants } from 'node:os'
import { promises as fs } from 'node:fs'
import { basename } from 'node:path'
import type { Employee } from '@shared/employees'
import type { EventInput } from '@shared/events/schema'
import type { AuditLog } from '../events/audit'
import type { EventStore } from '../events/store'
import { describeError, type Logger } from '../logging/logger'
import {
  INTERRUPT_SEQUENCE,
  getEnv,
  pathApi,
  planTerminate,
  safeChildEnv,
  type Env,
  type PlatformId,
  type TerminationMode,
  type TerminationPlan,
} from '../platform'
import type { ProviderAdapter } from '../providers/types'
import type { ProviderRegistry } from '../providers/registry'
import type { AgentToolContext } from '../mcp/agent-tools'
import type { McpEndpoint } from '../mcp/server'
import type { HookRegistration, HookServer } from './hook-server'
import { bracketedPaste, sanitizePrompt } from './prompt'
import { spawnNodePty, type PtyProcess, type PtySpawn } from './pty'
import { Scrollback } from './scrollback'
import { AgentTracker } from './tracker'

/** Environment variable that carries an agent's report token. Never written to disk. */
export const HOOK_TOKEN_ENV = 'SHOKUBA_HOOK_TOKEN'

const DEFAULT_COLS = 120
const DEFAULT_ROWS = 32
/** After pasting, let the terminal finish taking the text before pressing Enter. */
const PASTE_SETTLE_MS = 150
/** How long an agent counts as "receiving input" if it never reports starting a turn. */
const RECEIVING_TIMEOUT_MS = 5_000
const GRACEFUL_STOP_MS = 3_000
const FORCE_STOP_MS = 2_000

export type AgentRuntimeErrorCode =
  | 'already-running'
  | 'not-running'
  | 'unknown-provider'
  | 'provider-unavailable'
  | 'invalid-working-directory'
  | 'launch-failed'
  | 'not-ready'

export class AgentRuntimeError extends Error {
  constructor(
    readonly code: AgentRuntimeErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AgentRuntimeError'
  }
}

export interface AgentRuntimeDeps {
  events: EventStore
  audit: AuditLog
  providers: ProviderRegistry
  hooks: HookServer
  logger: Logger
  platform: PlatformId
  /** The environment agents inherit from (filtered by an allow-list before use). */
  env: Env
  home: string
  /** Shokuba's data directory; each agent gets a folder under `agents/`. */
  dataDir: string
  /** The tools agents may call (task submission etc.), served on each agent's own endpoint. */
  mcp?: McpEndpoint<AgentToolContext>
  /**
   * An agent's turn ended. Returns text to continue the agent with (a queued message), or
   * null. `canContinue` says whether this provider can be continued at all.
   */
  onTurnFinished?: (employeeId: string, canContinue: boolean) => string | null
  /**
   * A tool call is about to run. Returns a reason to refuse it (the circuit breaker), or
   * null to let it run.
   */
  decideTool?: (
    employeeId: string,
    toolName: string,
    summary: string,
    toolUseId: string | undefined,
  ) => string | null
  spawnPty?: PtySpawn
  killProcess?: (plan: TerminationPlan) => void
  gracefulStopMs?: number
  /** Overridable so tests need not wait for a real terminal to settle. */
  pasteSettleMs?: number
}

interface Session {
  employee: Employee
  adapter: ProviderAdapter
  tracker: AgentTracker
  pty: PtyProcess
  scrollback: Scrollback
  registration: HookRegistration
  stopRequested: boolean
  exited: Promise<void>
  /** Input was just pasted; the agent has not yet reported starting a turn. Nothing else may be pasted. */
  receiving: boolean
}

/** `offset` is the stream position *after* `data` (see Scrollback.total). */
export type TerminalListener = (employeeId: string, data: string, offset: number) => void

export interface TerminalReplay {
  data: string
  /** Stream position at the end of `data`; live chunks at or before it are already included. */
  offset: number
}

/**
 * Owns every running agent. Providers describe *what* to launch and how to read its
 * reports; this class does the launching, the terminal, the reporting channel and the
 * shutdown — identically for every provider.
 */
export class AgentRuntime {
  private readonly sessions = new Map<string, Session>()
  private readonly starting = new Set<string>()
  /** Final terminal text of agents that have exited, so the panel can still show why. */
  private readonly finished = new Map<string, TerminalReplay>()
  private readonly terminalListeners = new Set<TerminalListener>()
  /** The last size each terminal panel reported, so the next launch starts at the right size. */
  private readonly lastSize = new Map<string, { cols: number; rows: number }>()
  private readonly spawnPty: PtySpawn
  private readonly killProcess: (plan: TerminationPlan) => void
  private readonly gracefulStopMs: number
  private readonly pasteSettleMs: number

  constructor(private readonly deps: AgentRuntimeDeps) {
    this.pasteSettleMs = deps.pasteSettleMs ?? PASTE_SETTLE_MS
    this.spawnPty = deps.spawnPty ?? spawnNodePty
    this.killProcess = deps.killProcess ?? defaultKill
    this.gracefulStopMs = deps.gracefulStopMs ?? GRACEFUL_STOP_MS
  }

  isRunning(employeeId: string): boolean {
    return this.sessions.has(employeeId)
  }

  onTerminalData(listener: TerminalListener): () => void {
    this.terminalListeners.add(listener)
    return () => {
      this.terminalListeners.delete(listener)
    }
  }

  async start(employee: Employee): Promise<void> {
    if (this.sessions.has(employee.id) || this.starting.has(employee.id)) {
      throw new AgentRuntimeError('already-running', `${employee.name} is already running`)
    }
    this.starting.add(employee.id)
    try {
      await this.launch(employee)
    } finally {
      this.starting.delete(employee.id)
    }
  }

  private async launch(employee: Employee): Promise<void> {
    const { platform, env, home, dataDir, hooks } = this.deps

    const adapter = this.deps.providers.get(employee.providerId)
    if (!adapter) {
      throw new AgentRuntimeError('unknown-provider', `Unknown provider "${employee.providerId}"`)
    }

    const installation = await adapter.detect({ platform, env, home })
    if (!installation.found || installation.path === null || installation.problem) {
      throw new AgentRuntimeError(
        'provider-unavailable',
        installation.problem ?? `${adapter.displayName} is not available`,
      )
    }

    const cwd = await resolveWorkingDirectory(employee.workingDirectory)
    const tracker = new AgentTracker(employee.id, adapter.observation.source)
    const scrollback = new Scrollback()

    let session: Session | undefined
    const { mcp } = this.deps
    const registration = hooks.register(
      employee.id,
      (raw) => (session ? this.report(session, raw) : undefined),
      // Who is calling comes from the connection's token, never from anything in the message.
      mcp
        ? (message) =>
            mcp.handle(message, { employeeId: employee.id, source: adapter.observation.source })
        : undefined,
    )

    try {
      const runDir = pathApi(platform).join(dataDir, 'agents', employee.id)
      await fs.mkdir(runDir, { recursive: true, mode: 0o700 })

      const launch = adapter.buildLaunch({
        platform,
        env,
        employee,
        executable: installation.path,
        report: {
          url: registration.url,
          tokenEnvVar: HOOK_TOKEN_ENV,
          mcpUrl: registration.mcpUrl,
        },
        runDir,
      })
      for (const file of launch.files) {
        // Adapters name plain files; refuse anything that could escape the run directory.
        if (basename(file.name) !== file.name || file.name.length === 0) {
          throw new Error(`Adapter tried to write outside its run directory: "${file.name}"`)
        }
        await fs.writeFile(pathApi(platform).join(runDir, file.name), file.content, { mode: 0o600 })
      }

      this.publish(tracker.start())

      const size = this.lastSize.get(employee.id) ?? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS }
      const pty = this.spawnPty(launch.file, launch.args, {
        cwd,
        cols: size.cols,
        rows: size.rows,
        env: safeChildEnv(platform, env, {
          ...inheritedEnv(platform, env, launch.inheritEnv ?? []),
          ...launch.env,
          COLORTERM: 'truecolor',
          [HOOK_TOKEN_ENV]: registration.token,
        }),
      })

      let markExited: () => void = () => {}
      const exited = new Promise<void>((resolve) => {
        markExited = resolve
      })
      session = {
        employee,
        adapter,
        tracker,
        pty,
        scrollback,
        registration,
        stopRequested: false,
        exited,
        receiving: false,
      }
      this.sessions.set(employee.id, session)
      this.finished.delete(employee.id)

      const live = session
      pty.onData((data) => {
        live.scrollback.append(data)
        for (const listener of this.terminalListeners) {
          listener(employee.id, data, live.scrollback.total)
        }
      })
      pty.onExit((exit) => {
        this.onExit(live, exit)
        markExited()
      })

      this.publish([
        {
          type: 'agent.started',
          source: 'system',
          actorId: employee.id,
          payload: { employeeId: employee.id, pid: pty.pid },
        },
      ])
      this.deps.audit.record({
        actor: 'user',
        action: 'agent.start',
        target: employee.id,
        detail: {
          provider: adapter.id,
          workingDirectory: cwd,
          model: employee.model,
          permissionMode: employee.permissionMode,
          pid: pty.pid,
        },
      })
    } catch (error) {
      registration.unregister()
      this.sessions.delete(employee.id)
      // If the process did start before something else failed, do not leave it running unwatched.
      if (session) this.terminate(session, 'force')
      const { message } = describeError(error)
      this.publish([
        ...(tracker.state === 'offline'
          ? []
          : tracker.exited(false, `failed to launch: ${message}`)),
        {
          type: 'agent.error',
          source: 'system',
          actorId: employee.id,
          payload: {
            employeeId: employee.id,
            code: 'launch-failed',
            message: message.slice(0, 1000),
          },
        },
      ])
      throw new AgentRuntimeError('launch-failed', message)
    }
  }

  /** Ask an agent to stop: gracefully first, then forcefully. Resolves once it has exited. */
  async stop(employeeId: string): Promise<void> {
    const session = this.sessions.get(employeeId)
    if (!session) return
    session.stopRequested = true
    this.deps.audit.record({ actor: 'user', action: 'agent.stop', target: employeeId })

    this.terminate(session, 'graceful')
    if (await this.waitForExit(session, this.gracefulStopMs)) return

    this.deps.logger.warn('agent.stop.forced', { employeeId })
    this.terminate(session, 'force')
    await this.waitForExit(session, FORCE_STOP_MS)
  }

  /** Stop everything; used when the app quits. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)))
  }

  interrupt(employeeId: string): void {
    this.write(employeeId, INTERRUPT_SEQUENCE)
  }

  /**
   * Why a prompt must not be pasted into this agent's terminal right now, or null if it may
   * be. Pasting ends with Enter, so it is only safe when the agent is *known* to be sitting
   * at its input: running, and idle as *reported* (not merely guessed). Never while it waits
   * on a permission prompt, is starting up (setup or login screens), or has failed.
   */
  deliveryBlocker(employeeId: string): string | null {
    const session = this.sessions.get(employeeId)
    if (!session) return 'is not running'
    if (session.receiving) return 'is still receiving something'
    const { state, stateSource } = session.tracker
    if (state !== 'idle') return `is ${state}, not idle`
    if (stateSource !== 'reported' && stateSource !== 'simulated') {
      return 'looks idle, but that is only a guess'
    }
    return null
  }

  /**
   * Give the agent a prompt: pasted as one block, then Enter. Refuses unless
   * `deliveryBlocker` says it is safe, and re-checks after the paste settles.
   */
  async deliverPrompt(employeeId: string, text: string): Promise<void> {
    const session = this.require(employeeId)
    const blocker = this.deliveryBlocker(employeeId)
    if (blocker) throw new AgentRuntimeError('not-ready', `${session.employee.name} ${blocker}`)

    const paste = bracketedPaste(text)
    // Claimed before anything is written, so two deliveries can never overlap.
    session.receiving = true
    const release = setTimeout(() => {
      session.receiving = false
    }, RECEIVING_TIMEOUT_MS)
    release.unref?.()
    try {
      session.pty.write(paste)
      await new Promise((resolve) => setTimeout(resolve, this.pasteSettleMs))
      if (this.sessions.get(employeeId) !== session) {
        throw new AgentRuntimeError(
          'not-running',
          `${session.employee.name} stopped during delivery`,
        )
      }
      session.pty.write('\r')
    } catch (error) {
      clearTimeout(release)
      session.receiving = false
      throw error
    }
    this.deps.audit.record({
      actor: 'system',
      action: 'agent.deliver',
      target: employeeId,
      detail: { characters: paste.length },
    })
  }

  /** Send keystrokes to the agent's terminal. */
  write(employeeId: string, data: string): void {
    const session = this.require(employeeId)
    // Claude Code reports nothing for an interrupted turn; see AgentTracker.interrupted.
    if (data.includes(INTERRUPT_SEQUENCE) || data === '\x1b')
      this.publish(session.tracker.interrupted())
    session.pty.write(data)
  }

  /**
   * Resize an agent's terminal. Not an error when the agent is not running (a panel resizes
   * itself whenever it is shown): the size is remembered and used at the next launch.
   */
  resize(employeeId: string, cols: number, rows: number): void {
    this.lastSize.set(employeeId, { cols, rows })
    this.sessions.get(employeeId)?.pty.resize(cols, rows)
  }

  /** What the terminal has printed (bounded), for a panel that just opened. */
  replay(employeeId: string): TerminalReplay {
    const session = this.sessions.get(employeeId)
    if (session) return { data: session.scrollback.read(), offset: session.scrollback.total }
    return this.finished.get(employeeId) ?? { data: '', offset: 0 }
  }

  private require(employeeId: string): Session {
    const session = this.sessions.get(employeeId)
    if (!session) throw new AgentRuntimeError('not-running', 'That employee is not running')
    return session
  }

  /** Handle one report from the agent. What it returns is sent back to the agent as the hook's answer. */
  private report(session: Session, raw: unknown): unknown {
    let reply: unknown
    try {
      const { observation } = session.adapter
      for (const signal of observation.parse(raw)) {
        this.publish(session.tracker.onSignal(signal))

        // The agent has started a turn, so anything just pasted has been taken.
        if (signal.kind === 'turn-started') session.receiving = false

        // A call is about to run. If the circuit breaker refuses it, the answer to this very
        // report stops it, and the agent is told why.
        if (signal.kind === 'tool-started' && this.deps.decideTool && observation.deny) {
          const refusal = this.deps.decideTool(
            session.employee.id,
            signal.toolName,
            signal.summary,
            signal.toolUseId,
          )
          if (refusal) {
            reply = observation.deny(refusal)
            // It will not run, so no report of it finishing will ever come: say it here, or
            // the agent would look stuck in the middle of that call.
            this.publish(
              session.tracker.onSignal({
                kind: 'tool-finished',
                ...(signal.toolUseId && { toolUseId: signal.toolUseId }),
                toolName: signal.toolName,
                ok: false,
              }),
            )
          }
        }

        if (signal.kind === 'turn-finished' && this.deps.onTurnFinished) {
          const canContinue = observation.continuation !== undefined
          const next = this.deps.onTurnFinished(session.employee.id, canContinue)
          if (next && observation.continuation) {
            // The agent carries straight on, though no prompt was submitted: show it working.
            reply = observation.continuation(sanitizePrompt(next))
            session.receiving = false
            this.publish(session.tracker.onSignal({ kind: 'turn-started' }))
          }
        }
      }
    } catch (error) {
      this.deps.logger.error('agent.report.failed', {
        employeeId: session.employee.id,
        ...describeError(error),
      })
    }
    return reply
  }

  private onExit(session: Session, exit: { exitCode: number; signal: number | null }): void {
    const { employee } = session
    session.registration.unregister()
    this.sessions.delete(employee.id)
    this.finished.set(employee.id, {
      data: session.scrollback.read(),
      offset: session.scrollback.total,
    })

    const clean = session.stopRequested || exit.exitCode === 0
    const reason = session.stopRequested
      ? 'stopped by the user'
      : exit.signal !== null
        ? `killed by signal ${signalName(exit.signal)}`
        : `exited with code ${exit.exitCode}`

    this.publish([
      {
        type: 'agent.stopped',
        source: 'system',
        actorId: employee.id,
        payload: {
          employeeId: employee.id,
          exitCode: exit.exitCode,
          signal: exit.signal === null ? null : signalName(exit.signal),
        },
      },
      ...session.tracker.exited(clean, reason),
      ...(clean
        ? []
        : ([
            {
              type: 'agent.error',
              source: 'system',
              actorId: employee.id,
              payload: { employeeId: employee.id, code: 'exited', message: reason },
            },
          ] satisfies EventInput[])),
    ])
    this.deps.audit.record({
      actor: 'system',
      action: 'agent.exit',
      target: employee.id,
      detail: { exitCode: exit.exitCode, signal: exit.signal, clean },
    })
  }

  private terminate(session: Session, mode: TerminationMode): void {
    try {
      this.killProcess(planTerminate(this.deps.platform, session.pty.pid, mode))
    } catch (error) {
      this.deps.logger.warn('agent.terminate.failed', {
        employeeId: session.employee.id,
        mode,
        ...describeError(error),
      })
    }
  }

  private async waitForExit(session: Session, ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    })
    try {
      return await Promise.race([session.exited.then(() => true), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  private publish(outputs: readonly EventInput[]): void {
    for (const output of outputs) {
      try {
        this.deps.events.publish(output)
      } catch (error) {
        this.deps.logger.error('agent.event.rejected', {
          eventType: output.type,
          ...describeError(error),
        })
      }
    }
  }
}

/** The provider-declared variables that are actually set in Shokuba's environment. */
function inheritedEnv(
  platform: PlatformId,
  env: Env,
  names: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of names) {
    const value = getEnv(env, name, platform)
    if (value !== undefined) out[name] = value
  }
  return out
}

async function resolveWorkingDirectory(directory: string): Promise<string> {
  try {
    const real = await fs.realpath(directory)
    if (!(await fs.stat(real)).isDirectory()) throw new Error('not a directory')
    return real
  } catch {
    throw new AgentRuntimeError(
      'invalid-working-directory',
      `The working directory does not exist or is not a folder: ${directory}`,
    )
  }
}

function signalName(signal: number): string {
  for (const [name, value] of Object.entries(osConstants.signals)) {
    if (value === signal) return name
  }
  return String(signal)
}

/** Execute a termination plan from the platform layer. */
function defaultKill(plan: TerminationPlan): void {
  if (plan.kind === 'signal-group') {
    try {
      process.kill(-plan.pid, plan.signal)
    } catch (error) {
      // ESRCH: the group is already gone, which is the outcome we wanted.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    return
  }
  execFile(plan.command, plan.args, { windowsHide: true }, () => undefined)
}
