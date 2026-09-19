import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { createAgentServices } from './agents'
import { createServices } from './bootstrap'
import { MIGRATIONS } from './database/migrations'
import { createLogger, describeError } from './logging/logger'
import { findExecutable, safeChildEnv, shellCommand, toPlatformId } from './platform'
import { createMockAdapter } from './providers/mock/adapter'
import { ProviderRegistry } from './providers/registry'

export interface SmokeCheck {
  ok: boolean
  detail: string
}

export interface SmokeReport {
  ok: boolean
  runtime: { electron: string; node: string; abi: string; platform: string; arch: string }
  checks: Record<string, SmokeCheck>
}

const PTY_TIMEOUT_MS = 15_000

/**
 * Runs inside the real Electron runtime (`--shokuba-smoke-test`) and exercises what unit
 * tests cannot: the native modules under Electron's ABI, a real PTY, and a database
 * surviving a restart. Exits non-zero if anything fails, so CI can gate on it.
 */
export async function runSmokeTest(): Promise<SmokeReport> {
  const platform = toPlatformId()
  const checks: Record<string, SmokeCheck> = {}
  const dir = mkdtempSync(join(tmpdir(), 'shokuba-smoke-'))
  const logger = createLogger(() => {})

  const run = async (name: string, fn: () => Promise<string> | string): Promise<void> => {
    try {
      checks[name] = { ok: true, detail: await fn() }
    } catch (error) {
      checks[name] = { ok: false, detail: describeError(error).message }
    }
  }

  try {
    await run('sqlite-and-migrations', () => {
      const services = createServices({ dataDir: dir, version: 'smoke', platform, logger })
      try {
        if (services.schemaVersion !== MIGRATIONS.length) throw new Error('schema version mismatch')
        services.events.publish({
          type: 'agent.ready',
          source: 'system',
          payload: { employeeId: 'smoke' },
        })
        return `schema v${services.schemaVersion}, ${services.events.log.count()} events`
      } finally {
        services.close()
      }
    })

    await run('history-survives-restart', () => {
      const services = createServices({ dataDir: dir, version: 'smoke', platform, logger })
      try {
        const ready = services.events.log.list({ type: 'agent.ready' })
        if (ready.length !== 1)
          throw new Error(`expected 1 agent.ready after restart, found ${ready.length}`)
        return 'event written before restart was read back'
      } finally {
        services.close()
      }
    })

    await run('pty-spawn', () => spawnAndRead(platform, dir))

    await run('agent-pipeline', () => agentPipeline(platform, dir, logger))

    await run('locate-git', async () => {
      const found = await findExecutable('git', { platform, env: process.env, home: homedir() })
      if (!found) throw new Error('git not found on PATH or in common install locations')
      return found
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  return {
    ok: Object.values(checks).every((check) => check.ok),
    runtime: {
      electron: process.versions.electron ?? 'n/a',
      node: process.versions.node,
      abi: process.versions.modules,
      platform,
      arch: process.arch,
    },
    checks,
  }
}

/**
 * Run a command through the platform's default shell in a real PTY and read back what it
 * prints. A shell is a genuine console program, like the agent CLIs this will host, and
 * this also exercises `shellCommand()` on whatever OS the test runs on.
 */
function spawnAndRead(platform: ReturnType<typeof toPlatformId>, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const shell = shellCommand(platform, process.env, 'echo pty-ok')
    const via = `${shell.file} ${shell.args.join(' ')}`
    const child = pty.spawn(shell.file, [...shell.args], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: safeChildEnv(platform, process.env),
    })

    let output = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(
        new Error(
          `PTY did not exit within ${PTY_TIMEOUT_MS}ms via [${via}] (output so far: "${output.trim()}")`,
        ),
      )
    }, PTY_TIMEOUT_MS)

    child.onData((data) => {
      output += data
    })
    child.onExit(({ exitCode }) => {
      clearTimeout(timer)
      if (exitCode === 0 && output.includes('pty-ok'))
        resolve(`pid ${child.pid} exited 0 via ${shell.file}, output "${output.trim()}"`)
      else reject(new Error(`exit ${exitCode} via [${via}], output "${output.trim()}"`))
    })
  })
}

async function waitFor(predicate: () => boolean, what: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * The whole agent pipeline on the real runtime: a demo agent runs in a real PTY, reports
 * what it is doing over the loopback hook server, and those reports become events, states
 * and a clean shutdown. Only the "AI" is scripted; everything Shokuba does is real.
 */
async function agentPipeline(
  platform: ReturnType<typeof toPlatformId>,
  dir: string,
  logger: ReturnType<typeof createLogger>,
): Promise<string> {
  const services = createServices({
    dataDir: join(dir, 'pipeline'),
    version: 'smoke',
    platform,
    logger,
  })
  const agents = await createAgentServices(services, {
    platform,
    env: process.env,
    home: homedir(),
    providers: new ProviderRegistry([createMockAdapter({ stepMs: 40 })]),
    gracefulStopMs: 2_000,
  })

  try {
    const workdir = join(dir, 'pipeline-work')
    mkdirSync(workdir)
    const employee = await agents.employees.create({
      name: 'Smoke',
      role: 'Tester',
      providerId: 'mock',
      workingDirectory: workdir,
    })
    const stateOf = (): string => agents.views.snapshot([employee.id]).views[0]?.state ?? 'unknown'
    const seen = (type: string): number => services.events.log.list({ type: type as never }).length

    await agents.runtime.start(employee)
    await waitFor(() => stateOf() === 'idle', 'the demo agent to report in', 20_000)

    agents.runtime.write(employee.id, 'go\r')
    await waitFor(() => seen('agent.turn.finished') > 0, 'the scripted turn to finish', 20_000)

    const tools = services.events.log.list({ type: 'agent.tool.started' })
    if (tools.length !== 4) throw new Error(`expected 4 tool events, saw ${tools.length}`)
    if (!tools.every((event) => event.source === 'simulated')) {
      throw new Error('demo activity must be labelled simulated')
    }
    const changes = services.events.log
      .list({ type: 'agent.state.changed', limit: 200 })
      .map((event) => (event.type === 'agent.state.changed' ? event.payload.to : ''))
    for (const wanted of ['starting', 'idle', 'thinking', 'researching', 'coding', 'testing']) {
      if (!changes.includes(wanted as never))
        throw new Error(`never reached "${wanted}": ${changes.join(',')}`)
    }
    if (!agents.runtime.replay(employee.id).data.includes('[demo] done.')) {
      throw new Error('terminal output was not captured')
    }

    // Interrupting a turn (Claude Code reports nothing for this) must show idle and keep the agent alive.
    agents.runtime.write(employee.id, 'again\r')
    await waitFor(() => stateOf() !== 'idle', 'a second turn to start', 20_000)
    agents.runtime.interrupt(employee.id)
    if (stateOf() !== 'idle') throw new Error(`interrupt should show idle, state is ${stateOf()}`)
    await waitFor(
      () => agents.runtime.replay(employee.id).data.includes('[demo] interrupted.'),
      'the turn to abort',
      20_000,
    )
    if (!agents.runtime.isRunning(employee.id))
      throw new Error('an interrupt must not stop the agent')

    await agents.runtime.stop(employee.id)
    if (agents.runtime.isRunning(employee.id)) throw new Error('still running after stop')
    if (stateOf() !== 'stopped') throw new Error(`expected stopped, state is ${stateOf()}`)
    if (seen('agent.error') !== 0)
      throw new Error('a requested stop must not be recorded as an error')

    return `${changes.length} state changes (${[...new Set(changes)].join('>')}), 4 tool events, clean stop`
  } finally {
    await agents.close()
    services.close()
  }
}
