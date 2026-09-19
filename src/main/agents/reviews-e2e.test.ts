import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Employee } from '@shared/employees'
import type { Mission, Task } from '@shared/missions'
import { createServices, type Services } from '../bootstrap'
import { GitService } from '../git/service'
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
let repo: string
let noConfig: string
let services: Services
let agents: AgentServices
let git: GitService
/** Every agent process started, oldest first; `launches[i]` belongs to `spawns[i]`. */
const launches: LaunchInput[] = []
const spawns: Array<{ pty: FakePty; options: PtySpawnOptions }> = []
/** Set to make newly started agents never report in (like Claude Code stuck on a login screen). */
let reportIn = true

const adapter: ProviderAdapter = {
  id: 'fake',
  displayName: 'Fake',
  capabilities: { simulated: false, supportsModelSelection: false, permissionModes: ['default'] },
  observation: {
    kind: 'hooks',
    source: 'reported',
    parse: parseClaudeHook,
    continuation: (text) => ({ decision: 'block', reason: text }),
  },
  detect: async () => ({ found: true, path: '/bin/fake', version: '1', problem: null }),
  buildLaunch(input) {
    launches.push(input)
    return { file: input.executable, args: [], env: {}, files: [] }
  },
}

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Setup',
      '-c',
      'user.email=setup@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: noConfig, GIT_CONFIG_NOSYSTEM: '1' },
    },
  ).trim()
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

/** The newest process running for an employee: the one whose token is currently valid. */
function current(employee: Employee): Agent {
  const index = launches.map((l) => l.employee.id).lastIndexOf(employee.id)
  const spawned = spawns[index]
  const launch = launches[index]
  if (!spawned || !launch) throw new Error(`${employee.name} has not been started`)
  return { employee, pty: spawned.pty, options: spawned.options, launch }
}

/** Bring the agent services up over the current database, as Shokuba does at startup. */
/** Wait for something that involves real Git work; a Windows runner needs far longer than a laptop. */
const until = (check: () => void, options: { timeout?: number } = {}): Promise<void> =>
  vi.waitFor(check, { timeout: 20_000, interval: 25, ...options })

async function startAgents(): Promise<AgentServices> {
  const started = await createAgentServices(services, {
    platform: toPlatformId(),
    env: process.env,
    home: '/home/u',
    providers: new ProviderRegistry([adapter]),
    git,
    pasteSettleMs: 2,
    gracefulStopMs: 20,
    restartWaitMs: 1_500,
    spawnPty: (_file, _args, options) => {
      const pty = new FakePty(4000 + spawns.length)
      spawns.push({ pty, options })
      const index = spawns.length - 1
      // Like Claude Code, a started agent reports in a moment later.
      if (reportIn) {
        setTimeout(() => {
          const launch = launches[index]
          if (!launch) return
          void hook(
            { employee: launch.employee as Employee, pty, options, launch },
            { hook_event_name: 'SessionStart' },
          )
        }, 15)
      }
      return pty
    },
  })
  // Never signal a real process: these pids are made up. "Killing" one just makes it exit.
  ;(started.runtime as unknown as { killProcess: (plan: TerminationPlan) => void }).killProcess = (
    plan,
  ) => {
    const target = spawns.find(({ pty }) =>
      plan.kind === 'signal-group' ? plan.pid === pty.pid : plan.args.includes(String(pty.pid)),
    )
    target?.pty.exit()
  }
  return started
}

beforeEach(async () => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'shokuba-reviews-')))
  noConfig = join(dir, 'no-git-config')
  writeFileSync(noConfig, '')
  repo = join(dir, 'repo')
  mkdirSync(repo)
  sh(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  sh(repo, 'add', '-A')
  sh(repo, 'commit', '-qm', 'base')

  launches.length = 0
  spawns.length = 0
  reportIn = true
  services = createServices({
    dataDir: join(dir, 'data'),
    version: 'test',
    platform: toPlatformId(),
    logger: createLogger(() => {}),
  })
  git = await GitService.locate({
    platform: toPlatformId(),
    env: process.env,
    home: homedir(),
    dataDir: join(dir, 'data'),
    gitEnv: { GIT_CONFIG_GLOBAL: noConfig, GIT_CONFIG_NOSYSTEM: '1' },
  })
  agents = await startAgents()
})

afterEach(async () => {
  agents.reviewCleaner.stop()
  agents.cleaner.stop()
  agents.reviews.stop()
  agents.verification.stop()
  agents.breaker.stop()
  agents.router.stop()
  agents.dispatcher.stop()
  await agents.hooks.close()
  agents.views.dispose()
  services.close()
  rmSync(dir, { recursive: true, force: true })
})

async function hire(name: string, folder = repo): Promise<Employee> {
  const employee = await agents.employees.create({
    name,
    role: 'Engineer',
    providerId: 'fake',
    workingDirectory: folder,
  })
  await agents.runtime.start(employee)
  await until(() => expect(agents.runtime.deliveryBlocker(employee.id)).toBeNull())
  return employee
}

const typed = (agent: Agent): string => agent.pty.written.join('')

/** A mission with one task per (title, assignee), already running. */
function launchMission(...tasks: Array<[title: string, who: Employee]>): {
  mission: Mission
  tasks: Task[]
} {
  const mission = agents.missions.createMission({ title: 'Ship login' })
  const made = tasks.map(([title, who]) =>
    agents.missions.createTask({ missionId: mission.id, title, assigneeId: who.id }),
  )
  agents.missions.missionAction(mission.id, 'run')
  return { mission, tasks: made }
}

const statusOf = (id: string) => agents.missions.getTask(id)?.status

/** The tools an agent is offered right now. */
async function toolsOf(agent: Agent): Promise<string[]> {
  const response = await fetch(agent.launch.report.mcpUrl, {
    method: 'POST',
    headers: auth(agent),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  const body = (await response.json()) as { result: { tools: Array<{ name: string }> } }
  return body.result.tools.map((t) => t.name)
}

const SUMMARY = 'ZZ-the-author-calls-this-flawless'

/** Ren builds a task and submits it; returns the task and the folder Ren worked in. */
async function submittedTask(ren: Employee): Promise<{ task: Task; folder: string }> {
  const { tasks } = launchMission(['Build it', ren])
  const task = tasks[0] as Task
  await until(() => expect(statusOf(task.id)).toBe('in_progress'))
  const agent = current(ren)
  const folder = agent.options.cwd
  await hook(agent, { hook_event_name: 'UserPromptSubmit' })
  writeFileSync(join(folder, 'a.txt'), 'one\nTWO\nthree\n')
  await tool(agent, 'submit_task', { summary: SUMMARY })
  await hook(agent, { hook_event_name: 'Stop' })
  return { task, folder }
}

/** Ask for a review and wait until the reviewer has it and is reading. */
async function startReview(task: Task, reviewer: Employee): Promise<Agent> {
  await agents.reviews.request(task.id, reviewer.id, 'manual')
  await until(() => expect(agents.reviews.hasActive(reviewer.id)).toBe(true))
  return current(reviewer)
}

describe('an independent review, end to end', () => {
  it('has a different employee read the change in a folder of its own, in plan mode, and report advice', async () => {
    const ren = await hire('Ren')
    const sora = await hire('Sora')
    const { task, folder } = await submittedTask(ren)
    const submittedCommit = sh(folder, 'rev-parse', 'HEAD')

    const reading = await startReview(task, sora)

    // Sora was started again in a folder that is the code exactly as submitted, held to plan mode.
    expect(launches.at(-1)?.employee.permissionMode).toBe('plan')
    expect(reading.options.cwd).not.toBe(folder)
    expect(reading.options.cwd.startsWith(git.worktreesRoot)).toBe(true)
    expect(sh(reading.options.cwd, 'rev-parse', 'HEAD')).toBe(submittedCommit)
    expect(sh(reading.options.cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')

    // They were handed what was asked and the change, and not the author's account of it.
    await until(() => expect(typed(reading)).toContain('[Shokuba review]'))
    expect(typed(reading)).toContain('Build it')
    expect(typed(reading)).toContain('+TWO')
    expect(typed(reading)).not.toContain(SUMMARY)

    // The review tools exist for the reviewer, and for nobody else.
    expect(await toolsOf(reading)).toContain('submit_review')
    expect(await toolsOf(current(ren))).not.toContain('submit_review')

    // What they hand in is kept as advice: the task is exactly where it was.
    await hook(reading, { hook_event_name: 'UserPromptSubmit' })
    const said = await tool(reading, 'submit_review', {
      verdict: 'request_changes',
      summary: 'The second line should not be shouting.',
      findings: [{ severity: 'minor', file: 'a.txt', line: 2, note: 'TWO is upper-case.' }],
    })
    expect(said).toContain('Review handed in: request changes, with 1 finding')
    await hook(reading, { hook_event_name: 'Stop' })

    expect(statusOf(task.id)).toBe('submitted')
    const shown = await agents.reviews.forTask(task.id)
    expect(shown.latest).toMatchObject({
      state: 'submitted',
      reviewerId: sora.id,
      verdict: 'request_changes',
      commit: submittedCommit,
    })
    expect(shown.latest?.findings).toHaveLength(1)
    expect(shown.outOfDate).toBe(false)
    expect(await toolsOf(reading)).not.toContain('submit_review')
  })

  it('will not hand the author their own work to review', async () => {
    const ren = await hire('Ren')
    const { task } = await submittedTask(ren)
    await expect(agents.reviews.request(task.id, ren.id, 'manual')).rejects.toThrow(
      'The author cannot review their own work',
    )
    expect((await agents.reviews.forTask(task.id)).latest).toBeNull()
  })

  it('does not give the reviewer a task until they have handed in the review, then does, in a normal session', async () => {
    const ren = await hire('Ren')
    const sora = await hire('Sora')
    const { task } = await submittedTask(ren)
    const reading = await startReview(task, sora)

    const second = agents.missions.createMission({ title: 'Later' })
    const later = agents.missions.createTask({
      missionId: second.id,
      title: 'Sora’s own job',
      assigneeId: sora.id,
    })
    agents.missions.missionAction(second.id, 'run')
    await hook(reading, { hook_event_name: 'UserPromptSubmit' })
    await hook(reading, { hook_event_name: 'Stop' }) // between steps they look idle
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(statusOf(later.id)).toBe('ready')
    expect(current(sora).pty).toBe(reading.pty)

    await tool(reading, 'submit_review', { verdict: 'approve', summary: 'Fine.' })
    await hook(reading, { hook_event_name: 'Stop' })
    await until(() => expect(statusOf(later.id)).toBe('in_progress'))
    // Their own job runs in a session of their own kind, not the plan-mode one used for reading.
    expect(launches.at(-1)?.employee.permissionMode).toBe(sora.permissionMode)
    expect(current(sora).options.cwd).not.toBe(reading.options.cwd)
  })

  it('drops the review and interrupts the reviewer when the task is sent back', async () => {
    const ren = await hire('Ren')
    const sora = await hire('Sora')
    const { task } = await submittedTask(ren)
    const reading = await startReview(task, sora)

    await agents.tasks.action(task.id, { action: 'request-changes', note: 'Not like that.' })
    expect((await agents.reviews.forTask(task.id)).latest?.state).toBe('cancelled')
    expect(agents.reviews.hasActive(sora.id)).toBe(false)
    expect(reading.pty.written).toContain(INTERRUPT_SEQUENCE)
  })

  it('removes the reading folder once the reviewer has moved on, and never touches the author’s', async () => {
    const ren = await hire('Ren')
    const sora = await hire('Sora')
    const { task, folder } = await submittedTask(ren)
    const reading = await startReview(task, sora)
    await hook(reading, { hook_event_name: 'UserPromptSubmit' })
    await tool(reading, 'submit_review', { verdict: 'approve', summary: 'Fine.' })
    await hook(reading, { hook_event_name: 'Stop' })

    // The reviewer is still in it, so it stays.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(existsSync(reading.options.cwd)).toBe(true)

    await agents.runtime.stop(sora.id)
    await until(() => expect(existsSync(reading.options.cwd)).toBe(false))
    expect(existsSync(folder)).toBe(true)
  })
})
