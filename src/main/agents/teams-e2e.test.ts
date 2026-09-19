import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Employee } from '@shared/employees'
import { createServices, type Services } from '../bootstrap'
import { createLogger } from '../logging/logger'
import { toPlatformId } from '../platform'
import type { TerminationPlan } from '../platform/process'
import { parseClaudeHook } from '../providers/claude-code/hooks'
import { ProviderRegistry } from '../providers/registry'
import type { LaunchInput, ProviderAdapter } from '../providers/types'
import { createAgentServices, type AgentServices } from './index'
import type { PtyProcess, PtySpawnOptions } from './pty'
import { HOOK_TOKEN_ENV } from './runtime'

class FakePty implements PtyProcess {
  readonly written: string[] = []
  private readonly exitListeners: Array<
    (exit: { exitCode: number; signal: number | null }) => void
  > = []
  constructor(readonly pid: number) {}
  onData(): void {}
  onExit(listener: (exit: { exitCode: number; signal: number | null }) => void): void {
    this.exitListeners.push(listener)
  }
  write(data: string): void {
    this.written.push(data)
  }
  resize(): void {}
  exit(): void {
    for (const listener of this.exitListeners) listener({ exitCode: 0, signal: null })
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
const launches: LaunchInput[] = []
const spawns: Array<{ pty: FakePty; options: PtySpawnOptions }> = []

// Same shape as the real Claude Code adapter: hooks in, a Stop continuation and a deny out.
const adapter: ProviderAdapter = {
  id: 'fake',
  displayName: 'Fake',
  capabilities: { simulated: false, supportsModelSelection: false, permissionModes: ['default'] },
  observation: {
    kind: 'hooks',
    source: 'reported',
    parse: parseClaudeHook,
    continuation: (text) => ({ decision: 'block', reason: text }),
    deny: (reason) => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  },
  detect: async () => ({ found: true, path: '/bin/fake', version: '1', problem: null }),
  buildLaunch(input) {
    launches.push(input)
    return { file: input.executable, args: [], env: {}, files: [] }
  },
}

beforeEach(async () => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'shokuba-teams-e2e-')))
  mkdirSync(join(dir, 'work'))
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
      const pty = new FakePty(3000 + spawns.length)
      spawns.push({ pty, options })
      return pty
    },
  })
  // Never signal a real process: these pids are made up. "Killing" one just makes it exit.
  ;(agents.runtime as unknown as { killProcess: (plan: TerminationPlan) => void }).killProcess = (
    plan,
  ) => {
    const target = spawns.find(({ pty }) =>
      plan.kind === 'signal-group' ? plan.pid === pty.pid : plan.args.includes(String(pty.pid)),
    )
    target?.pty.exit()
  }
})

afterEach(async () => {
  agents.breaker.stop()
  agents.router.stop()
  agents.dispatcher.stop()
  await agents.hooks.close()
  agents.views.dispose()
  services.close()
  rmSync(dir, { recursive: true, force: true })
})

type Placement = { isManager?: boolean; reportsTo?: string; instructions?: string }

function create(name: string, role = 'Engineer', team: Placement = {}): Promise<Employee> {
  return agents.employees.create({
    name,
    role,
    providerId: 'fake',
    workingDirectory: join(dir, 'work'),
    ...team,
  })
}

const hire = async (name: string, role = 'Engineer', team: Placement = {}): Promise<Agent> =>
  boot(await create(name, role, team))

/** Start an employee's agent and have it report in, like Claude Code's SessionStart. */
async function boot(employee: Employee): Promise<Agent> {
  await agents.runtime.start(employee)
  const index = spawns.length - 1
  const spawned = spawns[index]
  const launch = launches[index]
  if (!spawned || !launch) throw new Error('agent did not launch')
  const agent: Agent = { employee, pty: spawned.pty, options: spawned.options, launch }
  await hook(agent, { hook_event_name: 'SessionStart' })
  return agent
}

const auth = (agent: Agent) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${agent.options.env[HOOK_TOKEN_ENV]}`,
})

/** Send a hook report; returns what Shokuba answered. */
async function hook(
  agent: Agent,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(agent.launch.report.url, {
    method: 'POST',
    headers: auth(agent),
    body: JSON.stringify(payload),
  })
  return (await response.json()) as Record<string, unknown>
}

async function tool(
  agent: Agent,
  name: string,
  args: object = {},
): Promise<{ text: string; isError: boolean }> {
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
  const body = (await response.json()) as {
    result: { content: Array<{ text: string }>; isError?: boolean }
  }
  return { text: body.result.content[0]?.text ?? '', isError: body.result.isError === true }
}

const viewOf = (agent: Agent) => agents.views.snapshot([agent.employee.id]).views[0]
const typed = (agent: Agent): string => agent.pty.written.join('')
const launchOf = (agent: Agent): LaunchInput => {
  const found = launches.find((l) => l.employee.id === agent.employee.id)
  if (!found) throw new Error('no launch')
  return found
}

/** Mira leads; Sora and Ren report to her; Kai has no manager. */
async function team() {
  // The manager starts last, so what her agent is told at launch includes her whole team.
  const manager = await create('Mira', 'Manager', {
    isManager: true,
    instructions: 'Lead the team.',
  })
  const sora = await hire('Sora', 'QA', { reportsTo: manager.id })
  const ren = await hire('Ren', 'Engineer', { reportsTo: manager.id })
  const kai = await hire('Kai', 'Engineer')
  const mira = await boot(manager)
  return { mira, sora, ren, kai }
}

describe('a team with a manager, end to end', () => {
  it('tells each agent where it sits when it starts', async () => {
    const { mira, sora, kai } = await team()
    expect(launchOf(mira).team).toEqual({
      manager: null,
      reports: [
        { name: 'Sora', role: 'QA' },
        { name: 'Ren', role: 'Engineer' },
      ],
    })
    expect(launchOf(mira).employee).toMatchObject({
      isManager: true,
      instructions: 'Lead the team.',
    })
    expect(launchOf(sora).team).toEqual({ manager: { name: 'Mira', role: 'Manager' }, reports: [] })
    expect(launchOf(kai).team).toEqual({ manager: null, reports: [] })
  })

  it('refuses an employee who writes to the person, and nothing reaches the inbox', async () => {
    const { sora } = await team()
    await hook(sora, { hook_event_name: 'UserPromptSubmit' })
    const refused = await tool(sora, 'send_message', {
      to: 'human',
      subject: 'Decision',
      body: 'SQLite or Postgres?',
    })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('You report to Mira')
    expect(agents.messages.listConversations()).toEqual([])
  })

  it('carries a question from an employee, through the manager, to the person', async () => {
    const { mira, sora } = await team()
    await hook(sora, { hook_event_name: 'UserPromptSubmit' })

    // 1. The employee asks the manager.
    const up = await tool(sora, 'send_message', {
      to: 'Mira',
      subject: 'Need the person to choose',
      body: 'SQLite or Postgres for the tests?',
      kind: 'question',
    })
    expect(up.isError).toBe(false)
    await vi.waitFor(() => expect(mira.pty.written.at(-1)).toBe('\r'))
    expect(typed(mira)).toContain('SQLite or Postgres for the tests?')
    expect(typed(mira)).toContain('From: Sora (QA), a teammate agent')

    // 2. The manager takes it to the person.
    await hook(mira, { hook_event_name: 'UserPromptSubmit' })
    const onward = await tool(mira, 'send_message', {
      to: 'human',
      subject: 'Sora needs a decision',
      body: 'Sora asks: SQLite or Postgres for the tests?',
    })
    expect(onward.isError).toBe(false)

    // The person's inbox has the manager's message, and nothing from Sora.
    const inbox = agents.messages
      .listConversations()
      .flatMap((c) => c.messages)
      .filter((m) => m.toId === 'human')
    expect(inbox.map((m) => m.fromId)).toEqual([mira.employee.id])
    // Nothing was typed into anyone's terminal for the person's inbox.
    expect(typed(sora)).toBe('')
  })

  it('still lets employees talk to their teammates', async () => {
    const { sora, ren } = await team()
    await hook(sora, { hook_event_name: 'UserPromptSubmit' })
    const sent = await tool(sora, 'send_message', {
      to: 'Ren',
      subject: 'Login',
      body: 'Is /login a POST?',
    })
    expect(sent.isError).toBe(false)
    await vi.waitFor(() => expect(ren.pty.written.at(-1)).toBe('\r'))
    expect(typed(ren)).toContain('Is /login a POST?')
  })

  it('leaves an employee with no manager able to write to the person, as before', async () => {
    const { kai } = await team()
    await hook(kai, { hook_event_name: 'UserPromptSubmit' })
    const sent = await tool(kai, 'send_message', {
      to: 'human',
      subject: 'Hi',
      body: 'Anyone there?',
    })
    expect(sent.isError).toBe(false)
  })

  it('lets the person write to any employee directly', async () => {
    const { sora } = await team()
    agents.messages.sendFromHuman({
      toId: sora.employee.id,
      subject: 'Steer',
      body: 'Focus on login',
    })
    await vi.waitFor(() => expect(typed(sora)).toContain('Focus on login'))
  })

  it('tells the manager when an employee is blocked on a task', async () => {
    const { mira, sora } = await team()
    const mission = agents.missions.createMission({ title: 'Ship login' })
    agents.missions.createTask({
      missionId: mission.id,
      title: 'Test login',
      assigneeId: sora.employee.id,
    })
    agents.missions.missionAction(mission.id, 'run')
    await vi.waitFor(() => expect(typed(sora)).toContain('Test login'))
    await hook(sora, { hook_event_name: 'UserPromptSubmit' })

    const blocked = await tool(sora, 'report_blocked', { reason: 'There is no test database' })
    expect(blocked.text).toContain('Mira, your manager, has been told')
    await vi.waitFor(() => expect(typed(mira)).toContain('There is no test database'))
    expect(typed(mira)).toContain('Blocked: Test login')
    expect(agents.missions.listMissions()[0]?.tasks[0]?.status).toBe('blocked')
  })

  it('lets a limited employee still ask their manager for help, though not a teammate', async () => {
    const { sora } = await team()
    await hook(sora, { hook_event_name: 'UserPromptSubmit' })
    for (let i = 0; i < 8; i++) {
      await hook(sora, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_use_id: `tu-${i}`,
      })
    }
    expect(viewOf(sora)?.breakerLevel).toBe('constrain')

    const toManager = await tool(sora, 'send_message', {
      to: 'Mira',
      subject: 'Stuck',
      body: 'Tests keep failing',
    })
    expect(toManager.isError).toBe(false)
    const toTeammate = await tool(sora, 'send_message', { to: 'Ren', subject: 's', body: 'x' })
    expect(toTeammate.isError).toBe(true)
    expect(toTeammate.text).toContain('message your manager (to: "Mira")')
  })

  it('shows the structure to an agent that asks who is on the team', async () => {
    const { mira, sora } = await team()
    const asEmployee = await tool(sora, 'list_teammates')
    expect(asEmployee.text).toContain('Mira (Manager) — your manager')
    expect(asEmployee.text).not.toContain('to: "human"')
    const asManager = await tool(mira, 'list_teammates')
    expect(asManager.text).toContain('Sora (QA) — reports to you')
    expect(asManager.text).toContain('Ren (Engineer) — reports to you')
    expect(asManager.text).toContain('Kai (Engineer)')
  })
})
