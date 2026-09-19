import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Employee } from '@shared/employees'
import { createServices, type Services } from '../bootstrap'
import { createLogger } from '../logging/logger'
import { toPlatformId } from '../platform'
import { INTERRUPT_SEQUENCE, type TerminationPlan } from '../platform/process'
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
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'shokuba-breaker-e2e-')))
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

async function hire(name: string, role = 'Engineer'): Promise<Agent> {
  const employee = await agents.employees.create({
    name,
    role,
    providerId: 'fake',
    workingDirectory: join(dir, 'work'),
  })
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

let toolUse = 0
/** The agent is about to run a tool; what Shokuba answers decides whether it does. */
const preTool = (
  agent: Agent,
  name: string,
  input: Record<string, unknown> = {},
): Promise<Record<string, unknown>> =>
  hook(agent, {
    hook_event_name: 'PreToolUse',
    tool_name: name,
    tool_input: input,
    tool_use_id: `tu-${++toolUse}`,
  })

const runTests = (agent: Agent) => preTool(agent, 'Bash', { command: 'npm test' })
const isDeny = (answer: Record<string, unknown>): boolean =>
  (answer['hookSpecificOutput'] as { permissionDecision?: string } | undefined)
    ?.permissionDecision === 'deny'
const reasonOf = (answer: Record<string, unknown>): string =>
  (answer['hookSpecificOutput'] as { permissionDecisionReason?: string } | undefined)
    ?.permissionDecisionReason ?? ''

const viewOf = (agent: Agent) => agents.views.snapshot([agent.employee.id]).views[0]
const typed = (agent: Agent): string => agent.pty.written.join('')

describe('the circuit breaker, end to end', () => {
  it('lets an agent repeat itself a few times, and refuses the call once it is running away', async () => {
    const mika = await hire('Mika')
    await hook(mika, { hook_event_name: 'UserPromptSubmit' })

    const answers: Array<Record<string, unknown>> = []
    for (let i = 0; i < 7; i++) answers.push(await runTests(mika))
    expect(answers.every((a) => !isDeny(a))).toBe(true)
    expect(viewOf(mika)?.breakerLevel).toBe('warning')

    const eighth = await runTests(mika)
    expect(isDeny(eighth)).toBe(true)
    expect(reasonOf(eighth)).toContain('circuit breaker')
    expect(reasonOf(eighth)).toContain('Do not repeat it')
    expect(viewOf(mika)).toMatchObject({ breakerLevel: 'constrain' })
    expect(viewOf(mika)?.breakerReason).toBe('the same call (Run npm test) 8 times in a row')

    // The refusal is on the record, and the call is not left looking "in progress".
    const denied = services.events.log.list({ type: 'breaker.denied' })
    expect(denied).toHaveLength(1)
    expect(denied[0]?.payload).toMatchObject({ employeeId: mika.employee.id, toolName: 'Bash' })
    expect(viewOf(mika)?.activity).toBeNull()
  })

  it('lets a constrained agent get on with anything that is not the loop', async () => {
    const mika = await hire('Mika')
    await hook(mika, { hook_event_name: 'UserPromptSubmit' })
    for (let i = 0; i < 8; i++) await runTests(mika)

    expect(isDeny(await preTool(mika, 'Read', { file_path: '/work/README.md' }))).toBe(false)
    expect(isDeny(await preTool(mika, 'Bash', { command: 'npm run lint' }))).toBe(false)
    expect(isDeny(await preTool(mika, 'Edit', { file_path: '/work/a.ts' }))).toBe(false)
    // The loop itself is only refused while the agent is still in it.
    expect(isDeny(await runTests(mika))).toBe(false)
  })

  it('pauses a runaway agent: interrupts it, refuses everything but handing the work back', async () => {
    const mika = await hire('Mika')
    await hook(mika, { hook_event_name: 'UserPromptSubmit' })
    for (let i = 0; i < 12; i++) await runTests(mika)

    expect(viewOf(mika)).toMatchObject({ breakerLevel: 'pause' })
    expect(mika.pty.written).toContain(INTERRUPT_SEQUENCE)

    const ls = await preTool(mika, 'Bash', { command: 'ls' })
    expect(isDeny(ls)).toBe(true)
    expect(reasonOf(ls)).toContain('paused you')
    expect(isDeny(await preTool(mika, 'Read', { file_path: '/work/x' }))).toBe(true)

    // It can still hand back what it has, or say it is stuck.
    expect(isDeny(await preTool(mika, 'mcp__shokuba__report_blocked', {}))).toBe(false)
    expect(isDeny(await preTool(mika, 'mcp__shokuba__submit_task', {}))).toBe(false)
    expect(isDeny(await preTool(mika, 'mcp__shokuba__get_current_task', {}))).toBe(false)
    expect(isDeny(await preTool(mika, 'mcp__shokuba__send_message', {}))).toBe(true)
  })

  it('does not pause an agent for the calls it refused itself', async () => {
    const mika = await hire('Mika')
    await hook(mika, { hook_event_name: 'UserPromptSubmit' })
    for (let i = 0; i < 80; i++) {
      await preTool(mika, 'Write', { file_path: `/work/file-${i}.ts` })
    }
    expect(viewOf(mika)?.breakerLevel).toBe('constrain')

    // Each further edit is refused, and each refusal is reported as a call that did not succeed.
    for (let i = 0; i < 20; i++) {
      const answer = await preTool(mika, 'Write', { file_path: `/work/more-${i}.ts` })
      expect(isDeny(answer)).toBe(true)
    }
    expect(viewOf(mika)).toMatchObject({ breakerLevel: 'constrain' })
    expect(viewOf(mika)?.breakerReason).toContain('different files edited')
  })

  it('holds back new tasks from a constrained agent, and hands them over once a person resets it', async () => {
    const mika = await hire('Mika')
    await hook(mika, { hook_event_name: 'UserPromptSubmit' })
    for (let i = 0; i < 8; i++) await runTests(mika)
    await hook(mika, { hook_event_name: 'Stop' }) // idle again, and reported so
    expect(viewOf(mika)?.breakerLevel).toBe('constrain')

    const mission = agents.missions.createMission({ title: 'Ship login' })
    agents.missions.createTask({
      missionId: mission.id,
      title: 'Build it',
      assigneeId: mika.employee.id,
    })
    agents.missions.missionAction(mission.id, 'run')

    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(mika.pty.written.filter((w) => w !== INTERRUPT_SEQUENCE)).toEqual([])
    const held = agents.missions.listMissions()[0]?.tasks[0]
    expect(held?.status).toBe('ready')

    agents.breaker.reset(mika.employee.id)
    expect(viewOf(mika)).toMatchObject({ breakerLevel: 'normal', breakerReason: null })

    // No other event is needed: lifting the restriction is itself what lets the task go.
    await vi.waitFor(() => expect(typed(mika)).toContain('Build it'))
    expect(agents.missions.listMissions()[0]?.tasks[0]?.status).toBe('in_progress')
  })

  it('stops a constrained agent messaging its teammates, but not asking for help', async () => {
    const mika = await hire('Mika')
    await hire('Ren', 'Reviewer')
    await hook(mika, { hook_event_name: 'UserPromptSubmit' })
    for (let i = 0; i < 8; i++) await runTests(mika)

    const refused = await tool(mika, 'send_message', { to: 'Ren', subject: 's', body: 'hey' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('circuit breaker')
    expect(refused.text).toContain('to: "human"')
    expect(agents.messages.listConversations()).toEqual([])

    const asked = await tool(mika, 'send_message', {
      to: 'human',
      subject: 'Stuck',
      body: 'I keep running the tests and they keep failing.',
    })
    expect(asked.isError).toBe(false)
    expect(agents.messages.listConversations()).toHaveLength(1)
  })

  it('keeps other agents out of a constrained one, but not the person', async () => {
    const mika = await hire('Mika')
    const ren = await hire('Ren', 'Reviewer')
    await hook(mika, { hook_event_name: 'UserPromptSubmit' })
    await hook(ren, { hook_event_name: 'UserPromptSubmit' })
    await tool(ren, 'send_message', { to: 'Mika', subject: 'Q', body: 'from a teammate' })
    for (let i = 0; i < 8; i++) await runTests(mika) // now constrained, with a teammate's message waiting
    agents.messages.sendFromHuman({
      toId: mika.employee.id,
      subject: 'Steer',
      body: 'Stop running the tests; read the failure instead.',
    })

    // Mika's turn ends. The person's message comes through; the teammate's does not.
    const answer = await hook(mika, { hook_event_name: 'Stop' })
    expect(answer['decision']).toBe('block')
    expect(String(answer['reason'])).toContain('read the failure instead')
    expect(String(answer['reason'])).not.toContain('from a teammate')

    // Once a person has reset it, the teammate's message follows at the end of the next turn.
    agents.breaker.reset(mika.employee.id)
    const later = await hook(mika, { hook_event_name: 'Stop' })
    expect(String(later['reason'])).toContain('from a teammate')
  })

  it('a person can pause an agent by hand, and stop it', async () => {
    const mika = await hire('Mika')
    await hook(mika, { hook_event_name: 'UserPromptSubmit' })

    agents.breaker.pause(mika.employee.id)
    expect(viewOf(mika)).toMatchObject({ breakerLevel: 'pause', breakerReason: 'paused by you' })
    expect(mika.pty.written).toContain(INTERRUPT_SEQUENCE)
    expect(isDeny(await preTool(mika, 'Read', { file_path: '/work/x' }))).toBe(true)

    await agents.breaker.stopAgent(mika.employee.id)
    expect(services.events.log.list({ type: 'agent.stopped' })).toHaveLength(1)
  })

  it('a restarted agent starts clean', async () => {
    const mika = await hire('Mika')
    await hook(mika, { hook_event_name: 'UserPromptSubmit' })
    for (let i = 0; i < 12; i++) await runTests(mika)
    expect(viewOf(mika)?.breakerLevel).toBe('pause')

    await agents.runtime.stop(mika.employee.id)
    await agents.runtime.start(mika.employee)
    expect(viewOf(mika)).toMatchObject({ breakerLevel: 'normal', breakerReason: null })
    const restarted = services.events.log.list({ type: 'breaker.state.changed' }).at(-1)
    expect(restarted?.payload).toMatchObject({ from: 'pause', to: 'normal', rule: 'restarted' })
  })

  it('leaves an agent alone that never trips anything', async () => {
    const mika = await hire('Mika')
    await hook(mika, { hook_event_name: 'UserPromptSubmit' })
    for (let i = 0; i < 30; i++) {
      const answer = await preTool(mika, 'Bash', { command: `echo ${i}` })
      expect(isDeny(answer)).toBe(false)
    }
    expect(viewOf(mika)?.breakerLevel).toBe('normal')
    expect(services.events.log.list({ type: 'breaker.state.changed' })).toEqual([])
  })
})
