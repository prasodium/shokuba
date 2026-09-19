import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Employee } from '@shared/employees'
import type { Mission, Task } from '@shared/missions'
import { createServices, type Services } from '../bootstrap'
import { createLogger } from '../logging/logger'
import { toPlatformId } from '../platform'
import { parseClaudeHook } from '../providers/claude-code/hooks'
import { ProviderRegistry } from '../providers/registry'
import type { LaunchInput, ProviderAdapter } from '../providers/types'
import { createAgentServices, type AgentServices } from './index'
import type { PtyProcess, PtySpawnOptions } from './pty'
import { HOOK_TOKEN_ENV } from './runtime'

const ESC = String.fromCharCode(27)

class FakePty implements PtyProcess {
  readonly written: string[] = []
  private readonly dataListeners: Array<(data: string) => void> = []
  private readonly exitListeners: Array<
    (exit: { exitCode: number; signal: number | null }) => void
  > = []
  constructor(readonly pid: number) {}
  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener)
  }
  onExit(listener: (exit: { exitCode: number; signal: number | null }) => void): void {
    this.exitListeners.push(listener)
  }
  write(data: string): void {
    this.written.push(data)
  }
  resize(): void {}
  exit(exitCode: number): void {
    for (const listener of this.exitListeners) listener({ exitCode, signal: null })
  }
}

interface Agent {
  employee: Employee
  pty: FakePty
  options: PtySpawnOptions
  launch: LaunchInput
}

let dir: string
let services: Services
let agents: AgentServices
const started: Agent[] = []
const launches: LaunchInput[] = []
const spawns: Array<{ pty: FakePty; options: PtySpawnOptions }> = []

const adapter: ProviderAdapter = {
  id: 'fake',
  displayName: 'Fake',
  capabilities: { simulated: false, supportsModelSelection: false, permissionModes: ['default'] },
  observation: { kind: 'hooks', source: 'reported', parse: parseClaudeHook },
  detect: async () => ({ found: true, path: '/bin/fake', version: '1', problem: null }),
  buildLaunch(input) {
    launches.push(input)
    return { file: input.executable, args: [], env: {}, files: [] }
  },
}

beforeEach(async () => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'shokuba-e2e-')))
  mkdirSync(join(dir, 'work'))
  started.length = 0
  launches.length = 0
  spawns.length = 0
  services = createServices({
    dataDir: join(dir, 'data'),
    version: 'test',
    platform: toPlatformId(),
    logger: createLogger(() => {}),
  })
  agents = await createAgentServices(services, {
    platform: toPlatformId(),
    env: { PATH: '/usr/bin' },
    home: '/home/u',
    providers: new ProviderRegistry([adapter]),
    pasteSettleMs: 2,
    gracefulStopMs: 20,
    spawnPty: (_file, _args, options) => {
      const pty = new FakePty(1000 + spawns.length)
      spawns.push({ pty, options })
      return pty
    },
  })
})

afterEach(async () => {
  await agents.hooks.close()
  agents.dispatcher.stop()
  agents.views.dispose()
  services.close()
  rmSync(dir, { recursive: true, force: true })
})

async function hire(name: string): Promise<Employee> {
  return agents.employees.create({
    name,
    role: 'Engineer',
    providerId: 'fake',
    workingDirectory: join(dir, 'work'),
  })
}

/** Bring an employee online and have the agent report in, like Claude Code's SessionStart. */
async function startAgent(employee: Employee): Promise<Agent> {
  await agents.runtime.start(employee)
  const index = started.length
  const spawned = spawns[index]
  const launch = launches[index]
  if (!spawned || !launch) throw new Error('agent did not launch')
  const agent: Agent = { employee, pty: spawned.pty, options: spawned.options, launch }
  started.push(agent)
  await hook(agent, { hook_event_name: 'SessionStart' })
  return agent
}

const auth = (agent: Agent) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${agent.options.env[HOOK_TOKEN_ENV]}`,
})

async function hook(agent: Agent, payload: Record<string, unknown>): Promise<void> {
  await fetch(agent.launch.report.url, {
    method: 'POST',
    headers: auth(agent),
    body: JSON.stringify(payload),
  })
}

/** The agent calls one of Shokuba's MCP tools over its own authenticated connection. */
async function tool(agent: Agent, name: string, args: object = {}): Promise<string> {
  const response = await fetch(agent.launch.report.mcpUrl, {
    method: 'POST',
    headers: auth(agent),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const body = (await response.json()) as { result: { content: Array<{ text: string }> } }
  return body.result.content[0]?.text ?? ''
}

const taskNamed = (mission: Mission, title: string): Task => {
  const found = agents.missions
    .listMissions()
    .find((m) => m.mission.id === mission.id)
    ?.tasks.find((t) => t.title === title)
  if (!found) throw new Error(`no task ${title}`)
  return found
}
const statusOf = (mission: Mission, title: string) => taskNamed(mission, title).status

/** What was typed into the agent's terminal: pasted blocks and the Enters after them. */
const typed = (agent: Agent): string => agent.pty.written.join('')

describe('a mission, end to end', () => {
  it('runs a dependent pair of tasks across two agents, with a person accepting each', async () => {
    const mika = await startAgent(await hire('Mika'))
    const ren = await startAgent(await hire('Ren'))

    const mission = agents.missions.createMission({ title: 'Ship login' })
    agents.missions.createTask({
      missionId: mission.id,
      title: 'Design the API',
      description: 'Sketch the endpoints',
      assigneeId: mika.employee.id,
    })
    agents.missions.createTask({
      missionId: mission.id,
      title: 'Build the API',
      assigneeId: ren.employee.id,
      dependsOn: [taskNamed(mission, 'Design the API').id],
    })

    // Nothing moves until the mission runs.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mika.pty.written).toEqual([])

    agents.missions.missionAction(mission.id, 'run')

    // Mika is idle and (reported) so the design task is pasted into her terminal, then Enter.
    await vi.waitFor(() => expect(statusOf(mission, 'Design the API')).toBe('in_progress'))
    await vi.waitFor(() => expect(mika.pty.written.at(-1)).toBe('\r'))
    expect(typed(mika)).toContain(`${ESC}[200~[Shokuba task]`)
    expect(typed(mika)).toContain('Design the API')
    expect(typed(mika)).toContain('Sketch the endpoints')
    // Ren's task depends on Mika's, so nothing was sent to Ren.
    expect(ren.pty.written).toEqual([])
    expect(statusOf(mission, 'Build the API')).toBe('pending')

    // Mika's agent works, then reports through Shokuba's MCP tools.
    await hook(mika, { hook_event_name: 'UserPromptSubmit' })
    expect(await tool(mika, 'get_current_task')).toContain('Design the API')
    expect(
      await tool(mika, 'submit_task', { summary: 'Designed POST /login and POST /logout' }),
    ).toContain('waiting for a person')
    await hook(mika, { hook_event_name: 'Stop' })

    // Submitted is a claim. Ren still waits.
    expect(statusOf(mission, 'Design the API')).toBe('submitted')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ren.pty.written).toEqual([])

    // A person accepts; only then is the dependent task handed to Ren, with Mika's summary.
    agents.missions.taskAction(taskNamed(mission, 'Design the API').id, { action: 'accept' })
    await vi.waitFor(() => expect(statusOf(mission, 'Build the API')).toBe('in_progress'))
    await vi.waitFor(() => expect(ren.pty.written.at(-1)).toBe('\r'))
    expect(typed(ren)).toContain('Build the API')
    expect(typed(ren)).toContain('Designed POST /login and POST /logout')

    await hook(ren, { hook_event_name: 'UserPromptSubmit' })
    await tool(ren, 'submit_task', { summary: 'Implemented both endpoints' })
    await hook(ren, { hook_event_name: 'Stop' })
    agents.missions.taskAction(taskNamed(mission, 'Build the API').id, { action: 'accept' })

    expect(agents.missions.getMission(mission.id)?.status).toBe('completed')

    // The whole story is in the log, in order, with who said what.
    const types = services.events.log.list({ limit: 1000 }).map((event) => event.type)
    for (const wanted of [
      'mission.created',
      'task.created',
      'task.dispatched',
      'task.status.changed',
      'mission.status.changed',
    ]) {
      expect(types).toContain(wanted)
    }
    const dispatched = services.events.log.list({ type: 'task.dispatched' })
    expect(
      dispatched.map((event) => (event.type === 'task.dispatched' ? event.payload.employeeId : '')),
    ).toEqual([mika.employee.id, ren.employee.id])
  })

  it('does not paste into an agent that is busy, and sends the task when it finishes', async () => {
    const mika = await startAgent(await hire('Mika'))
    await hook(mika, { hook_event_name: 'UserPromptSubmit' }) // a person gave her something to do

    const mission = agents.missions.createMission({ title: 'M' })
    agents.missions.createTask({
      missionId: mission.id,
      title: 'Queued',
      assigneeId: mika.employee.id,
    })
    agents.missions.missionAction(mission.id, 'run')

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(mika.pty.written).toEqual([])
    expect(statusOf(mission, 'Queued')).toBe('ready')

    await hook(mika, { hook_event_name: 'Stop' })
    await vi.waitFor(() => expect(statusOf(mission, 'Queued')).toBe('in_progress'))
    await vi.waitFor(() => expect(mika.pty.written.at(-1)).toBe('\r'))
  })

  it('never pastes into an agent waiting on a permission prompt', async () => {
    const mika = await startAgent(await hire('Mika'))
    await hook(mika, { hook_event_name: 'UserPromptSubmit' })
    await hook(mika, { hook_event_name: 'PermissionRequest', tool_name: 'Bash' })

    const mission = agents.missions.createMission({ title: 'M' })
    agents.missions.createTask({ missionId: mission.id, title: 'T', assigneeId: mika.employee.id })
    agents.missions.missionAction(mission.id, 'run')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(mika.pty.written).toEqual([])
  })

  it('blocks the task when the agent dies mid-work, and a person can retry it', async () => {
    const mika = await startAgent(await hire('Mika'))
    const mission = agents.missions.createMission({ title: 'M' })
    agents.missions.createTask({ missionId: mission.id, title: 'T', assigneeId: mika.employee.id })
    agents.missions.missionAction(mission.id, 'run')
    await vi.waitFor(() => expect(statusOf(mission, 'T')).toBe('in_progress'))

    mika.pty.exit(1)
    await vi.waitFor(() => expect(statusOf(mission, 'T')).toBe('blocked'))
    expect(taskNamed(mission, 'T').blockedReason).toBe('the agent stopped')

    agents.missions.taskAction(taskNamed(mission, 'T').id, { action: 'retry' })
    expect(statusOf(mission, 'T')).toBe('ready')
  })

  it('sends work back with feedback, which the agent receives on the next attempt', async () => {
    const mika = await startAgent(await hire('Mika'))
    const mission = agents.missions.createMission({ title: 'M' })
    agents.missions.createTask({ missionId: mission.id, title: 'T', assigneeId: mika.employee.id })
    agents.missions.missionAction(mission.id, 'run')
    await vi.waitFor(() => expect(mika.pty.written.at(-1)).toBe('\r'))
    await hook(mika, { hook_event_name: 'UserPromptSubmit' })
    await tool(mika, 'submit_task', { summary: 'first try' })
    await hook(mika, { hook_event_name: 'Stop' })

    agents.missions.taskAction(taskNamed(mission, 'T').id, {
      action: 'request-changes',
      note: 'Add a unit test',
    })
    await vi.waitFor(() => expect(taskNamed(mission, 'T').attempts).toBe(2))
    await vi.waitFor(() => expect(typed(mika)).toContain('Add a unit test'))
    expect(typed(mika)).toContain('Attempt: 2')
  })

  it('keeps an agent from submitting a task that is not its own, over the wire', async () => {
    const mika = await startAgent(await hire('Mika'))
    const ren = await startAgent(await hire('Ren'))
    const mission = agents.missions.createMission({ title: 'M' })
    agents.missions.createTask({
      missionId: mission.id,
      title: 'Rens',
      assigneeId: ren.employee.id,
    })
    agents.missions.missionAction(mission.id, 'run')
    await vi.waitFor(() => expect(statusOf(mission, 'Rens')).toBe('in_progress'))

    const answer = await tool(mika, 'submit_task', {
      taskId: taskNamed(mission, 'Rens').id,
      summary: 'mine',
    })
    expect(answer).toBe('That task is not yours')
    expect(statusOf(mission, 'Rens')).toBe('in_progress')
  })

  it('pauses: a paused mission hands out nothing new', async () => {
    const mika = await startAgent(await hire('Mika'))
    const mission = agents.missions.createMission({ title: 'M' })
    agents.missions.createTask({ missionId: mission.id, title: 'T', assigneeId: mika.employee.id })
    agents.missions.missionAction(mission.id, 'run')
    agents.missions.missionAction(mission.id, 'pause')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(statusOf(mission, 'T')).toBe('ready')
    expect(mika.pty.written).toEqual([])
  })
})
