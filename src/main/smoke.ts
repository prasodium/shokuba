import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import type { Employee } from '@shared/employees'
import { MAX_HOPS } from '@shared/messages'
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

    await run('message-pipeline', () => messagePipeline(platform, dir, logger))

    await run('breaker-pipeline', () => breakerPipeline(platform, dir, logger))

    await run('team-pipeline', () => teamPipeline(platform, dir, logger))

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

/**
 * Two agents that answer every message they receive, started off by a person. Nothing stops
 * that exchange by itself, so this proves the loop protection on the real runtime: messages
 * travel through real terminals (as continuations or pastes), the chain is counted by Shokuba
 * rather than claimed by the agents, and at the hop limit the next message is held and the
 * conversation halted for a person to decide.
 */
async function messagePipeline(
  platform: ReturnType<typeof toPlatformId>,
  dir: string,
  logger: ReturnType<typeof createLogger>,
): Promise<string> {
  const services = createServices({
    dataDir: join(dir, 'message-pipeline'),
    version: 'smoke',
    platform,
    logger,
  })
  const agents = await createAgentServices(services, {
    platform,
    env: process.env,
    home: homedir(),
    providers: new ProviderRegistry([createMockAdapter({ stepMs: 30, chatty: true })]),
    gracefulStopMs: 2_000,
  })

  const workdir = join(dir, 'message-work')
  mkdirSync(workdir)
  const ids: string[] = []

  try {
    for (const name of ['Ada', 'Bo']) {
      const employee = await agents.employees.create({
        name,
        role: 'Tester',
        providerId: 'mock',
        workingDirectory: workdir,
      })
      ids.push(employee.id)
      await agents.runtime.start(employee)
    }
    await waitFor(
      () => ids.every((id) => agents.runtime.deliveryBlocker(id) === null),
      'both demo agents to report in',
      20_000,
    )

    const [ada] = ids
    agents.messages.sendFromHuman({
      toId: ada as string,
      subject: 'Kick off',
      body: 'Say hello to a teammate.',
    })

    const conversation = ():
      ReturnType<typeof agents.messages.listConversations>[number] | undefined =>
      agents.messages.listConversations()[0]
    await waitFor(
      () => conversation()?.conversation.status === 'halted',
      'the runaway exchange to be halted',
      60_000,
    )

    const { messages, conversation: halted } = conversation() ?? {
      messages: [],
      conversation: undefined,
    }
    const held = messages.filter((message) => message.state === 'held')
    if (held.length !== 1) throw new Error(`expected exactly 1 held message, found ${held.length}`)
    // The person's message is hop 1 and resets the count, so agents get MAX_HOPS replies.
    if (messages.length !== MAX_HOPS + 2) {
      throw new Error(`expected ${MAX_HOPS + 2} messages in the chain, found ${messages.length}`)
    }
    if (held[0]?.hop !== MAX_HOPS + 2) throw new Error(`the held message was hop ${held[0]?.hop}`)
    const delivered = services.events.log.list({ type: 'message.delivered', limit: 200 })
    if (delivered.length !== MAX_HOPS + 1) {
      throw new Error(`expected ${MAX_HOPS + 1} deliveries, saw ${delivered.length}`)
    }
    const ways = new Set(
      delivered.map((event) => (event.type === 'message.delivered' ? event.payload.via : '')),
    )

    // A person ends it. Anything still waiting is held, not delivered.
    agents.messages.close(halted?.id ?? '')
    if (agents.messages.getConversation(halted?.id ?? '')?.status !== 'closed') {
      throw new Error('the conversation did not close')
    }
    return `${messages.length} messages, ${delivered.length} delivered (${[...ways].join(' + ')}), held at hop ${held[0]?.hop}, halted, closed`
  } catch (error) {
    const list = agents.messages.listConversations()
    const summary = list.map(
      (c) => `${c.conversation.status}:${c.messages.map((m) => `${m.hop}${m.state[0]}`).join(',')}`,
    )
    const tails = ids.map((id) => JSON.stringify(agents.runtime.replay(id).data.slice(-250)))
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${message} [conversations: ${summary.join(' | ') || 'none'}; terminals: ${tails.join(' | ')}]`,
      {
        cause: error,
      },
    )
  } finally {
    await agents.close()
    services.close()
  }
}

/**
 * The circuit breaker on real processes: a demo agent that loops is refused its call, a task
 * is held back from it while it is constrained and handed over once a person resets it, and one
 * that ignores the refusal is paused and interrupted for real. Only the "AI" is scripted.
 */
async function breakerPipeline(
  platform: ReturnType<typeof toPlatformId>,
  dir: string,
  logger: ReturnType<typeof createLogger>,
): Promise<string> {
  const services = createServices({
    dataDir: join(dir, 'breaker-pipeline'),
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

  const workdir = join(dir, 'breaker-work')
  mkdirSync(workdir)
  let id = ''

  try {
    const employee = await agents.employees.create({
      name: 'Ada',
      role: 'Tester',
      providerId: 'mock',
      workingDirectory: workdir,
    })
    id = employee.id
    await agents.runtime.start(employee)
    const idle = (what: string): Promise<void> =>
      waitFor(() => agents.runtime.deliveryBlocker(id) === null, what, 20_000)
    await idle('the demo agent to report in')

    // 1. A runaway loop: the same call, over and over. It is refused, and the agent stops.
    agents.runtime.write(id, 'loop\r')
    await waitFor(
      () => agents.breaker.levelOf(id) === 'constrain',
      'the loop to be constrained',
      20_000,
    )
    await waitFor(
      () => services.events.log.list({ type: 'breaker.denied' }).length > 0,
      'the looping call to be refused',
      20_000,
    )
    await idle('the agent to give up the loop')

    // 2. While constrained, it is given no new task.
    const mission = agents.missions.createMission({ title: 'Breaker smoke' })
    const task = agents.missions.createTask({
      missionId: mission.id,
      title: 'Check the build',
      assigneeId: id,
    })
    agents.missions.missionAction(mission.id, 'run')
    await new Promise((resolve) => setTimeout(resolve, 600))
    if (agents.missions.getTask(task.id)?.status !== 'ready') {
      throw new Error('a task was handed to an agent the breaker had constrained')
    }

    // 3. A person resets it; the held task goes out without anything else happening.
    agents.breaker.reset(id)
    await waitFor(
      () => agents.missions.getTask(task.id)?.status !== 'ready',
      'the held task to be handed over after the reset',
      20_000,
    )
    await waitFor(
      () => agents.missions.getTask(task.id)?.status === 'submitted',
      'the demo agent to hand the task back',
      30_000,
    )
    await idle('the agent to finish its task')

    // 4. An agent that ignores the refusal is paused, and its turn is really interrupted.
    agents.runtime.write(id, 'stubborn\r')
    await waitFor(
      () => agents.breaker.levelOf(id) === 'pause',
      'the stubborn agent to be paused',
      20_000,
    )
    await waitFor(
      () => agents.runtime.replay(id).data.includes('[demo] interrupted.'),
      'the paused agent to be interrupted',
      20_000,
    )

    const denied = services.events.log.list({ type: 'breaker.denied', limit: 200 }).length
    const changes = services.events.log
      .list({ type: 'breaker.state.changed', limit: 200 })
      .map((event) =>
        event.type === 'breaker.state.changed' ? `${event.payload.from}>${event.payload.to}` : '',
      )
    return `${denied} calls refused; ${changes.join(', ')}; held task released by a reset; paused agent interrupted`
  } catch (error) {
    const level = id ? agents.breaker.stateOf(id) : undefined
    const tail = id ? JSON.stringify(agents.runtime.replay(id).data.slice(-300)) : ''
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message} [breaker: ${JSON.stringify(level)}; terminal: ${tail}]`, {
      cause: error,
    })
  } finally {
    await agents.close()
    services.close()
  }
}

/**
 * A team on real processes: a demo manager drafts a mission for the person who reports to them
 * (over the real MCP connection), nothing is sent until the person runs it, the employee then
 * receives and submits the task, and that employee is refused when they try to message the
 * person directly. Only the "AI" is scripted.
 */
async function teamPipeline(
  platform: ReturnType<typeof toPlatformId>,
  dir: string,
  logger: ReturnType<typeof createLogger>,
): Promise<string> {
  const services = createServices({
    dataDir: join(dir, 'team-pipeline'),
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

  const workdir = join(dir, 'team-work')
  mkdirSync(workdir)
  const ids: string[] = []

  try {
    const create = (name: string, role: string, extra: object): Promise<Employee> =>
      agents.employees.create({
        name,
        role,
        providerId: 'mock',
        workingDirectory: workdir,
        ...extra,
      })
    const manager = await create('Mira', 'Manager', { isManager: true })
    const employee = await create('Ren', 'Engineer', { reportsTo: manager.id })
    for (const person of [manager, employee]) {
      ids.push(person.id)
      await agents.runtime.start(person)
    }
    await waitFor(
      () => ids.every((id) => agents.runtime.deliveryBlocker(id) === null),
      'both demo agents to report in',
      20_000,
    )

    // 1. The manager drafts a plan, through the real MCP connection.
    agents.runtime.write(manager.id, 'plan\r')
    const drafted = (): ReturnType<typeof agents.missions.listMissions>[number] | undefined =>
      agents.missions.listMissions().find((detail) => detail.mission.createdBy === manager.id)
    await waitFor(
      () => (drafted()?.tasks.length ?? 0) === 2,
      'the manager to draft two tasks',
      20_000,
    )
    if (drafted()?.mission.status !== 'draft') throw new Error("the manager's plan was not a draft")

    // 2. A draft sends nothing: the employee's task waits, untouched.
    await new Promise((resolve) => setTimeout(resolve, 600))
    const build = drafted()?.tasks.find((task) => task.title === 'Build the login form')
    if (build?.assigneeId !== employee.id)
      throw new Error('the task was not assigned to the employee')
    if (build.status !== 'ready') throw new Error(`a draft was acted on (task is ${build.status})`)

    // 3. The person runs it; the employee receives the task and submits it.
    const missionId = drafted()?.mission.id ?? ''
    agents.missions.missionAction(missionId, 'run')
    await waitFor(
      () => agents.missions.getTask(build.id)?.status === 'submitted',
      'the employee to receive the task and submit it',
      30_000,
    )

    // 4. The employee cannot go straight to the person.
    let refused = ''
    try {
      agents.messages.sendFromAgent(
        employee.id,
        { to: 'human', subject: 'Hello', body: 'Can I ask you something?' },
        { source: 'reported', employeeId: employee.id },
      )
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error)
    }
    if (!refused.includes('You report to Mira')) {
      throw new Error(`the employee was not stopped from messaging the person: "${refused}"`)
    }

    return 'the manager drafted a 2-task mission in its own name; nothing was sent until it was run; the employee then received and submitted it; a direct message to the person was refused'
  } catch (error) {
    const missions = agents.missions
      .listMissions()
      .map(
        (d) =>
          `${d.mission.status}/${d.mission.createdBy ? 'agent' : 'person'}:${d.tasks.map((t) => t.status).join(',')}`,
      )
    const tails = ids.map((id) => JSON.stringify(agents.runtime.replay(id).data.slice(-250)))
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${message} [missions: ${missions.join(' | ') || 'none'}; terminals: ${tails.join(' | ')}]`,
      {
        cause: error,
      },
    )
  } finally {
    await agents.close()
    services.close()
  }
}
