import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Employee } from '@shared/employees'
import type { Mission, Task } from '@shared/missions'
import { createServices, type Services } from '../bootstrap'
import { GitService } from '../git/service'
import { createLogger } from '../logging/logger'
import { removeTree, toPlatformId } from '../platform'
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
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'shokuba-isolation-')))
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
  agents.breaker.stop()
  agents.router.stop()
  agents.dispatcher.stop()
  await agents.hooks.close()
  agents.views.dispose()
  services.close()
  // Git makes its files read-only, which a plain delete cannot remove on Windows.
  await removeTree(dir)
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

/** The agent's turn: it does its work in `cwd`, then says it is finished, and its turn ends. */
async function doWork(who: Employee, file: string, text: string): Promise<string> {
  const agent = current(who)
  const cwd = agent.options.cwd
  await hook(agent, { hook_event_name: 'UserPromptSubmit' })
  writeFileSync(join(cwd, file), text)
  await tool(agent, 'submit_task', { summary: `Changed ${file}.` })
  await hook(agent, { hook_event_name: 'Stop' })
  return cwd
}

const statusOf = (id: string) => agents.missions.getTask(id)?.status

describe('a task in its own branch, end to end', () => {
  it('starts a fresh agent in the task’s own folder and hands it the task there', async () => {
    const ren = await hire('Ren')
    const before = current(ren)
    expect(before.options.cwd).toBe(repo)

    const { mission, tasks } = launchMission(['Build it', ren])
    const task = tasks[0] as Task
    await until(() => expect(statusOf(task.id)).toBe('in_progress'))

    // A second process was started, in the task's folder, and the first one stopped.
    expect(spawns).toHaveLength(2)
    const now = current(ren)
    expect(now.options.cwd).not.toBe(repo)
    expect(now.options.cwd.startsWith(git.worktreesRoot)).toBe(true)
    expect(now.pty).not.toBe(before.pty)
    expect(sh(now.options.cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`shokuba/task/${task.id}`)
    expect(sh(repo, 'branch', '--list', `shokuba/mission/${mission.id}`)).toContain(mission.id)

    // The briefing went to the new agent, with where it is working; the old one was not touched.
    await until(() => expect(typed(now)).toContain('Build it'))
    expect(typed(now)).toContain('isolated in its own Git branch')
    expect(typed(now)).toContain(now.options.cwd)
    expect(typed(before)).not.toContain('Build it')
    // Your own checkout and branch are as they were.
    expect(sh(repo, 'status', '--short')).toBe('')
    expect(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
  })

  it('saves the agent’s work as a commit when it submits, and shows it for review', async () => {
    const ren = await hire('Ren')
    const { tasks } = launchMission(['Build it', ren])
    const task = tasks[0] as Task
    await until(() => expect(statusOf(task.id)).toBe('in_progress'))
    const cwd = await doWork(ren, 'a.txt', 'one\nTWO\nthree\n')

    expect(sh(cwd, 'log', '-1', '--format=%an|%s')).toBe('Ren|Task: Build it')
    const changes = await agents.workspaces.changes(task.id)
    expect(changes).toMatchObject({ isolated: true, state: 'active' })
    expect(changes.isolated && changes.files).toEqual([
      { path: 'a.txt', added: 1, deleted: 1, binary: false },
    ])
    expect(changes.isolated && changes.diff).toContain('+TWO')
    expect(statusOf(task.id)).toBe('submitted')
  })

  it('merges accepted work into the mission branch, and never touches your branch', async () => {
    const ren = await hire('Ren')
    const { mission, tasks } = launchMission(['Build it', ren])
    const task = tasks[0] as Task
    await until(() => expect(statusOf(task.id)).toBe('in_progress'))
    await doWork(ren, 'a.txt', 'one\nTWO\nthree\n')
    const mainBefore = sh(repo, 'rev-parse', 'main')

    const accepted = await agents.tasks.action(task.id, { action: 'accept' })
    expect(accepted.status).toBe('done')
    expect(sh(repo, 'show', `shokuba/mission/${mission.id}:a.txt`)).toBe('one\nTWO\nthree')
    expect(sh(repo, 'rev-parse', 'main')).toBe(mainBefore)
    expect(sh(repo, 'status', '--short')).toBe('')
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
  })

  it('starts a dependent task from the work that was accepted before it', async () => {
    const ren = await hire('Ren')
    const sora = await hire('Sora')
    const mission = agents.missions.createMission({ title: 'Two steps' })
    const first = agents.missions.createTask({
      missionId: mission.id,
      title: 'First',
      assigneeId: ren.id,
    })
    const second = agents.missions.createTask({
      missionId: mission.id,
      title: 'Second',
      assigneeId: sora.id,
      dependsOn: [first.id],
    })
    agents.missions.missionAction(mission.id, 'run')
    await until(() => expect(statusOf(first.id)).toBe('in_progress'))
    await doWork(ren, 'a.txt', 'one\nFIRST\nthree\n')
    await agents.tasks.action(first.id, { action: 'accept' })

    // The second task is handed out only now, and its folder already has the first one's change.
    await until(() => expect(statusOf(second.id)).toBe('in_progress'))
    const folder = current(sora).options.cwd
    expect(readFileSync(join(folder, 'a.txt'), 'utf8')).toBe('one\nFIRST\nthree\n')
  })

  it('sends a conflicting task back to its agent with the files named and how to fix it', async () => {
    const ren = await hire('Ren')
    const sora = await hire('Sora')
    const { mission, tasks } = launchMission(['Ren’s change', ren], ['Sora’s change', sora])
    const [renTask, soraTask] = tasks as [Task, Task]
    await until(() => expect(statusOf(renTask.id)).toBe('in_progress'))
    await until(() => expect(statusOf(soraTask.id)).toBe('in_progress'))
    await doWork(ren, 'a.txt', 'one\nFROM-REN\nthree\n')
    const soraFolder = await doWork(sora, 'a.txt', 'one\nFROM-SORA\nthree\n')

    expect((await agents.tasks.action(renTask.id, { action: 'accept' })).status).toBe('done')
    const tip = sh(repo, 'rev-parse', `shokuba/mission/${mission.id}`)

    // Sora's work cannot be accepted as it is: it goes back to her, and nothing moved.
    const sent = await agents.tasks.action(soraTask.id, { action: 'accept' })
    expect(sent.status).toBe('changes_requested')
    expect(sent.reviewNote).toContain('conflicts with work accepted before yours, in a.txt')
    expect(sent.reviewNote).toContain(`git merge shokuba/mission/${mission.id}`)
    expect(sh(repo, 'rev-parse', `shokuba/mission/${mission.id}`)).toBe(tip)

    // She is still in her own folder, so she is given the task again there, without a restart.
    const spawnsBefore = spawns.length
    await until(() => expect(statusOf(soraTask.id)).toBe('in_progress'))
    expect(spawns).toHaveLength(spawnsBefore)
    expect(current(sora).options.cwd).toBe(soraFolder)
    await until(() => expect(typed(current(sora))).toContain('git merge shokuba/mission/'))

    // She resolves it the way she was told, and submits again; now it is accepted.
    const agent = current(sora)
    await hook(agent, { hook_event_name: 'UserPromptSubmit' })
    try {
      sh(soraFolder, 'merge', '--no-edit', `shokuba/mission/${mission.id}`)
    } catch {
      /* the conflict is expected */
    }
    writeFileSync(join(soraFolder, 'a.txt'), 'one\nFROM-REN and FROM-SORA\nthree\n')
    sh(soraFolder, 'add', '-A')
    sh(soraFolder, 'commit', '-qm', 'resolve')
    await tool(agent, 'submit_task', { summary: 'Resolved the conflict.' })
    expect((await agents.tasks.action(soraTask.id, { action: 'accept' })).status).toBe('done')
    expect(sh(repo, 'show', `shokuba/mission/${mission.id}:a.txt`)).toBe(
      'one\nFROM-REN and FROM-SORA\nthree',
    )
  })
})

describe('when a task cannot be isolated', () => {
  it('runs it in the employee’s own folder as before, without restarting anyone', async () => {
    const plain = join(dir, 'plain')
    mkdirSync(plain)
    const ren = await hire('Ren', plain)
    const { tasks } = launchMission(['No repo here', ren])
    const task = tasks[0] as Task
    await until(() => expect(statusOf(task.id)).toBe('in_progress'))

    expect(spawns).toHaveLength(1)
    expect(current(ren).options.cwd).toBe(realpathSync.native(plain))
    await until(() => expect(typed(current(ren))).toContain('No repo here'))
    expect(typed(current(ren))).not.toContain('isolated in its own Git branch')
    expect(await agents.workspaces.changes(task.id)).toEqual({
      isolated: false,
      reason: 'That folder is not inside a Git repository',
    })
    // Accepting it is just accepting it: there is nothing to merge.
    await doWork(ren, 'notes.txt', 'x')
    expect((await agents.tasks.action(task.id, { action: 'accept' })).status).toBe('done')
  })

  it('leaves the task waiting, unclaimed, if the restarted agent never reports in', async () => {
    const ren = await hire('Ren')
    reportIn = false // the fresh agent starts but never gets to its prompt
    const { tasks } = launchMission(['Build it', ren])
    const task = tasks[0] as Task
    await until(() => expect(spawns).toHaveLength(2))
    await new Promise((resolve) => setTimeout(resolve, 1_800))
    expect(statusOf(task.id)).toBe('ready')
    expect(typed(current(ren))).toBe('')
  })
})

describe('what the person is told', () => {
  it('shows the branch and files of an isolated task, and the reason for one that is not', async () => {
    const ren = await hire('Ren')
    const { tasks } = launchMission(['Build it', ren])
    const task = tasks[0] as Task
    expect(await agents.workspaces.changes(task.id)).toEqual({ isolated: false, reason: null })
    await until(() => expect(statusOf(task.id)).toBe('in_progress'))
    const changes = await agents.workspaces.changes(task.id)
    expect(changes).toMatchObject({ isolated: true, branch: `shokuba/task/${task.id}`, files: [] })
    expect(existsSync(current(ren).options.cwd)).toBe(true)
  })
})

describe('cleaning up after a task', () => {
  /** A task Ren has finished and the person has accepted; returns its working folder. */
  async function acceptedTask(
    who: Employee,
    title: string,
    file: string,
  ): Promise<{ task: Task; folder: string; mission: Mission }> {
    const { mission, tasks } = launchMission([title, who])
    const task = tasks[0] as Task
    await until(() => expect(statusOf(task.id)).toBe('in_progress'))
    const folder = await doWork(who, file, `${title}\n`)
    await agents.tasks.action(task.id, { action: 'accept' })
    return { task, folder, mission }
  }

  it('keeps the folder while its agent is still in it, and removes it once the agent has moved on', async () => {
    const ren = await hire('Ren')
    const mission = agents.missions.createMission({ title: 'Two steps' })
    const first = agents.missions.createTask({
      missionId: mission.id,
      title: 'First',
      assigneeId: ren.id,
    })
    const second = agents.missions.createTask({
      missionId: mission.id,
      title: 'Second',
      assigneeId: ren.id,
      dependsOn: [first.id],
    })
    agents.missions.missionAction(mission.id, 'run')
    await until(() => expect(statusOf(first.id)).toBe('in_progress'))
    const folder = await doWork(ren, 'first.txt', 'First\n')

    // Submitted, not yet accepted: its folder is kept, whatever else happens.
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(existsSync(folder)).toBe(true)

    // Accepting it hands Ren the second task, in a folder of its own; the first is now unoccupied.
    await agents.tasks.action(first.id, { action: 'accept' })
    await until(() => expect(statusOf(second.id)).toBe('in_progress'))
    await until(() => expect(existsSync(folder)).toBe(false))

    // The branch, and the work on it, stay, and can still be reviewed.
    expect(sh(repo, 'branch', '--list', `shokuba/task/${first.id}`)).toContain(first.id)
    expect(sh(repo, 'show', `shokuba/task/${first.id}:first.txt`)).toBe('First')
    // The folder goes first and the record follows (Git tidies its own bookkeeping in between,
    // which takes longer on Windows), so wait for the record instead of reading it in the gap.
    await until(async () => {
      expect(await agents.workspaces.changes(first.id)).toMatchObject({
        isolated: true,
        state: 'merged',
        folderRemoved: true,
      })
    })
    // The folder the agent is working in now was not touched.
    expect(existsSync(current(ren).options.cwd)).toBe(true)
    expect(current(ren).options.cwd).not.toBe(folder)
  })

  it('removes it when the agent is stopped', async () => {
    const ren = await hire('Ren')
    const { folder } = await acceptedTask(ren, 'First', 'first.txt')
    expect(existsSync(folder)).toBe(true)
    await agents.runtime.stop(ren.id)
    await until(() => expect(existsSync(folder)).toBe(false))
  })

  it('saves a cancelled task’s unsaved work to its branch before removing its folder', async () => {
    const ren = await hire('Ren')
    const { mission, tasks } = launchMission(['Abandoned', ren])
    const task = tasks[0] as Task
    await until(() => expect(statusOf(task.id)).toBe('in_progress'))
    const folder = current(ren).options.cwd
    writeFileSync(join(folder, 'unsaved.txt'), 'the agent had not submitted this\n')

    agents.missions.taskAction(task.id, { action: 'cancel' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(existsSync(folder)).toBe(true) // Ren is still in it

    await agents.runtime.stop(ren.id)
    await until(() => expect(existsSync(folder)).toBe(false))
    expect(sh(repo, 'show', `shokuba/task/${task.id}:unsaved.txt`)).toBe(
      'the agent had not submitted this',
    )
    expect(sh(repo, 'branch', '--list', `shokuba/mission/${mission.id}`)).toContain(mission.id)
  })

  it('leaves a task that is only waiting for review alone', async () => {
    const ren = await hire('Ren')
    const { tasks } = launchMission(['Build it', ren])
    const task = tasks[0] as Task
    await until(() => expect(statusOf(task.id)).toBe('in_progress'))
    const folder = await doWork(ren, 'a.txt', 'one\nTWO\nthree\n')
    await agents.runtime.stop(ren.id)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(statusOf(task.id)).toBe('submitted')
    expect(existsSync(folder)).toBe(true) // not finished, so its folder is kept
  })

  it('clears folders an earlier run left behind as soon as Shokuba starts', async () => {
    const ren = await hire('Ren')
    const { folder } = await acceptedTask(ren, 'First', 'first.txt')
    // Shokuba quits with the accepted task's folder still on disk (its agent was in it).
    await agents.close()
    expect(existsSync(folder)).toBe(true)

    agents = await startAgents()
    await until(() => expect(existsSync(folder)).toBe(false))
  })

  it('shows where the mission’s accepted work is collecting', async () => {
    const ren = await hire('Ren')
    const { mission } = await acceptedTask(ren, 'First', 'first.txt')
    const [branch] = await agents.workspaces.missionBranches(mission.id)
    expect(branch).toMatchObject({
      branch: `shokuba/mission/${mission.id}`,
      repoName: 'repo',
      ahead: 1,
    })
  })
})

describe('checks on submitted work, end to end', () => {
  /** Commands run through the shell as a person would write them. */
  const exists = (file: string): string =>
    `node -e "process.exit(require('fs').existsSync('${file}') ? 0 : 1)"`

  function setUpChecks(steps: Array<{ name: string; command: string }>, acknowledged = true) {
    return agents.checks.save({
      repoRoot: repo,
      acknowledged,
      steps: steps.map((step) => ({ kind: 'check' as const, ...step })),
    })
  }
  const latest = async (task: Task) => (await agents.verification.forTask(task.id)).latest

  it('runs on the agent’s committed work in its own folder, and passes when the work is right', async () => {
    setUpChecks([{ name: 'Notes exist', command: exists('notes.txt') }])
    const ren = await hire('Ren')
    const { tasks } = launchMission(['Write notes', ren])
    const task = tasks[0] as Task
    await until(() => expect(statusOf(task.id)).toBe('in_progress'))
    const folder = await doWork(ren, 'notes.txt', 'the notes\n')

    await until(async () => expect((await latest(task))?.state).toBe('passed'))
    const run = await latest(task)
    expect(run).toMatchObject({ trigger: 'auto', commit: sh(folder, 'rev-parse', 'HEAD') })
    expect(run?.results).toHaveLength(1)
    expect(run?.results[0]).toMatchObject({ name: 'Notes exist', state: 'passed', exitCode: 0 })
    // It checked the task's folder, which has the file; your own checkout never did.
    expect(existsSync(join(repo, 'notes.txt'))).toBe(false)
  })

  it('fails when the work is not right, and says which check and what it printed', async () => {
    setUpChecks([
      { name: 'Notes exist', command: exists('notes.txt') },
      { name: 'Says why', command: `node -e "console.log('checked the folder'); process.exit(2)"` },
    ])
    const ren = await hire('Ren')
    const { tasks } = launchMission(['Forget the notes', ren])
    const task = tasks[0] as Task
    await until(() => expect(statusOf(task.id)).toBe('in_progress'))
    await doWork(ren, 'something-else.txt', 'x\n')

    await until(async () => expect((await latest(task))?.state).toBe('failed'))
    const run = await latest(task)
    expect(run?.results.map((r) => [r.name, r.state, r.exitCode])).toEqual([
      ['Notes exist', 'failed', 1],
      ['Says why', 'failed', 2],
    ])
    expect(run?.results[1]?.output).toContain('checked the folder')
  })

  it('runs where the agent worked, not in your own checkout', async () => {
    setUpChecks([
      {
        name: 'Leaves a mark',
        command: `node -e "require('fs').writeFileSync('ran-here.txt', process.cwd())"`,
      },
    ])
    const ren = await hire('Ren')
    const { tasks } = launchMission(['Anything', ren])
    const task = tasks[0] as Task
    await until(() => expect(statusOf(task.id)).toBe('in_progress'))
    const folder = await doWork(ren, 'a.txt', 'one\nTWO\nthree\n')
    await until(async () => expect((await latest(task))?.state).toBe('passed'))
    expect(existsSync(join(folder, 'ran-here.txt'))).toBe(true)
    expect(existsSync(join(repo, 'ran-here.txt'))).toBe(false)
    expect(sh(repo, 'status', '--short')).toBe('')
  })

  it('does not run until the person has switched checks on', async () => {
    setUpChecks([{ name: 'Would run', command: exists('notes.txt') }], false)
    const ren = await hire('Ren')
    const { tasks } = launchMission(['Anything', ren])
    const task = tasks[0] as Task
    await until(() => expect(statusOf(task.id)).toBe('in_progress'))
    await doWork(ren, 'notes.txt', 'x\n')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await latest(task)).toBeNull()
    const verification = await agents.verification.forTask(task.id)
    expect(verification).toMatchObject({
      configured: false,
      reason: 'Checks are set up for this project but not switched on.',
    })
  })

  it('keeps the results after the task is accepted, and lists what it is set up to do', async () => {
    setUpChecks([{ name: 'Notes exist', command: exists('notes.txt') }])
    const ren = await hire('Ren')
    const { tasks } = launchMission(['Write notes', ren])
    const task = tasks[0] as Task
    await until(() => expect(statusOf(task.id)).toBe('in_progress'))
    await doWork(ren, 'notes.txt', 'x\n')
    await until(async () => expect((await latest(task))?.state).toBe('passed'))
    await agents.tasks.action(task.id, { action: 'accept' })
    expect(statusOf(task.id)).toBe('done')
    expect((await latest(task))?.state).toBe('passed')
    expect(await agents.verification.suggest(repo)).toEqual([])
  })
})
