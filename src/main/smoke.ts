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

    await run('mission-pipeline', () => missionPipeline(platform, dir, logger))

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

  let employeeId: string | undefined
  try {
    const workdir = join(dir, 'pipeline-work')
    mkdirSync(workdir)
    const employee = await agents.employees.create({
      name: 'Smoke',
      role: 'Tester',
      providerId: 'mock',
      workingDirectory: workdir,
    })
    employeeId = employee.id
    const stateOf = (): string => agents.views.snapshot([employee.id]).views[0]?.state ?? 'unknown'
    const seen = (type: string): number => services.events.log.list({ type: type as never }).length

    await agents.runtime.start(employee)
    await waitFor(() => stateOf() === 'idle', 'the demo agent to report in', 20_000)

    agents.runtime.write(employee.id, 'go\r')
    await waitFor(() => seen('agent.turn.finished') > 0, 'the scripted turn to finish', 20_000)

    const tools = services.events.log.list({ type: 'agent.tool.started' })
    // Four scripted tools, then the demo agent asks Shokuba (over MCP) whether it has a task.
    const toolNames = tools.map((event) =>
      event.type === 'agent.tool.started' ? event.payload.toolName : '',
    )
    const expected = ['Read', 'Grep', 'Edit', 'Bash', 'mcp__shokuba__get_current_task']
    if (toolNames.join(',') !== expected.join(',')) {
      throw new Error(`expected tools ${expected.join(',')}, saw ${toolNames.join(',')}`)
    }
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

    return `${changes.length} state changes (${[...new Set(changes)].join('>')}), ${tools.length} tool events, clean stop`
  } catch (error) {
    // Without this, a timeout on a machine nobody can log into says nothing about why.
    const states = services.events.log
      .list({ type: 'agent.state.changed', limit: 200 })
      .map((event) => (event.type === 'agent.state.changed' ? event.payload.to : ''))
    const tail = employeeId ? agents.runtime.replay(employeeId).data.slice(-500) : ''
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${message} [states: ${states.join('>') || 'none'}; terminal tail: ${JSON.stringify(tail)}]`,
      { cause: error },
    )
  } finally {
    await agents.close()
    services.close()
  }
}

/**
 * A mission across two agents on the real runtime: a task is pasted into a real terminal, the
 * demo agent does its turn and submits through Shokuba's MCP tools over authenticated HTTP,
 * a person accepts, and only then is the dependent task handed to the second agent.
 */
async function missionPipeline(
  platform: ReturnType<typeof toPlatformId>,
  dir: string,
  logger: ReturnType<typeof createLogger>,
): Promise<string> {
  const services = createServices({
    dataDir: join(dir, 'mission-pipeline'),
    version: 'smoke',
    platform,
    logger,
  })
  const agents = await createAgentServices(services, {
    platform,
    env: process.env,
    home: homedir(),
    providers: new ProviderRegistry([createMockAdapter({ stepMs: 30 })]),
    gracefulStopMs: 2_000,
  })

  const workdir = join(dir, 'mission-work')
  mkdirSync(workdir)
  const ids: string[] = []
  let missionId: string | undefined

  try {
    const hire = async (name: string): Promise<string> => {
      const employee = await agents.employees.create({
        name,
        role: 'Tester',
        providerId: 'mock',
        workingDirectory: workdir,
      })
      ids.push(employee.id)
      await agents.runtime.start(employee)
      return employee.id
    }
    const first = await hire('Ada')
    const second = await hire('Bo')
    // Tasks are only handed to an agent that has *reported* itself idle.
    await waitFor(
      () => ids.every((id) => agents.runtime.deliveryBlocker(id) === null),
      'both demo agents to report in',
      20_000,
    )

    const mission = agents.missions.createMission({ title: 'Smoke mission' })
    missionId = mission.id
    const a = agents.missions.createTask({
      missionId: mission.id,
      title: 'First',
      assigneeId: first,
    })
    const b = agents.missions.createTask({
      missionId: mission.id,
      title: 'Second',
      assigneeId: second,
      dependsOn: [a.id],
    })
    const statusOf = (id: string): string => agents.missions.getTask(id)?.status ?? 'missing'
    agents.missions.missionAction(mission.id, 'run')

    await waitFor(() => statusOf(a.id) === 'submitted', 'the first task to be submitted', 30_000)
    if (statusOf(b.id) !== 'pending')
      throw new Error('the dependent task started before its dependency')
    if (!agents.missions.getTask(a.id)?.summary) throw new Error('the agent submitted no summary')

    agents.missions.taskAction(a.id, { action: 'accept' })
    await waitFor(() => statusOf(b.id) === 'submitted', 'the second task to be submitted', 30_000)
    agents.missions.taskAction(b.id, { action: 'accept' })
    if (agents.missions.getMission(mission.id)?.status !== 'completed') {
      throw new Error('the mission did not complete')
    }

    const submissions = services.events.log
      .list({ type: 'task.status.changed', limit: 200 })
      .filter((event) => event.type === 'task.status.changed' && event.payload.to === 'submitted')
    if (!submissions.every((event) => event.source === 'simulated')) {
      throw new Error('demo submissions must be labelled simulated')
    }
    const dispatched = services.events.log.list({ type: 'task.dispatched' }).length
    return `2 tasks handed out (${dispatched} dispatches), submitted over MCP, accepted, mission completed`
  } catch (error) {
    const tasks = missionId
      ? (agents.missions.listMissions().find((m) => m.mission.id === missionId)?.tasks ?? [])
      : []
    const tails = ids.map((id) => JSON.stringify(agents.runtime.replay(id).data.slice(-300)))
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${message} [tasks: ${tasks.map((t) => `${t.title}=${t.status}`).join(', ') || 'none'}; terminals: ${tails.join(' | ')}]`,
      { cause: error },
    )
  } finally {
    await agents.close()
    services.close()
  }
}
