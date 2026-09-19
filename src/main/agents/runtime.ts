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
import type { HookRegistration, HookServer } from './hook-server'
import { spawnNodePty, type PtyProcess, type PtySpawn } from './pty'
import { Scrollback } from './scrollback'
import { AgentTracker } from './tracker'

/** Environment variable that carries an agent's report token. Never written to disk. */
export const HOOK_TOKEN_ENV = 'SHOKUBA_HOOK_TOKEN'

const DEFAULT_COLS = 120
const DEFAULT_ROWS = 32
const GRACEFUL_STOP_MS = 3_000
const FORCE_STOP_MS = 2_000

export type AgentRuntimeErrorCode =
  | 'already-running'
  | 'not-running'
  | 'unknown-provider'
  | 'provider-unavailable'
  | 'invalid-working-directory'
  | 'launch-failed'

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
  spawnPty?: PtySpawn
  killProcess?: (plan: TerminationPlan) => void
  gracefulStopMs?: number
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

  constructor(private readonly deps: AgentRuntimeDeps) {
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
    const registration = hooks.register(employee.id, (raw) => {
      if (session) this.report(session, raw)
    })

    try {
      const runDir = pathApi(platform).join(dataDir, 'agents', employee.id)
      await fs.mkdir(runDir, { recursive: true, mode: 0o700 })

      const launch = adapter.buildLaunch({
        platform,
        env,
        employee,
        executable: installation.path,
        report: { url: registration.url, tokenEnvVar: HOOK_TOKEN_ENV },
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

  private report(session: Session, raw: unknown): void {
    try {
      for (const signal of session.adapter.observation.parse(raw)) {
        this.publish(session.tracker.onSignal(signal))
      }
    } catch (error) {
      this.deps.logger.error('agent.report.failed', {
        employeeId: session.employee.id,
        ...describeError(error),
      })
    }
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
