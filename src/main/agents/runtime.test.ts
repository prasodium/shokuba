import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Employee } from '@shared/employees'
import type { ShokubaEvent } from '@shared/events/schema'
import { createServices, type Services } from '../bootstrap'
import { createLogger } from '../logging/logger'
import { toPlatformId, type TerminationPlan } from '../platform'
import { parseClaudeHook } from '../providers/claude-code/hooks'
import { ProviderRegistry } from '../providers/registry'
import type { LaunchInput, ProviderAdapter } from '../providers/types'
import { createAgentServices, type AgentServices } from './index'
import type { PtyProcess, PtySpawnOptions } from './pty'
import { AgentRuntimeError, HOOK_TOKEN_ENV } from './runtime'

class FakePty implements PtyProcess {
  readonly pid = 4242
  readonly written: string[] = []
  readonly resized: Array<[number, number]> = []
  private readonly dataListeners: Array<(data: string) => void> = []
  private readonly exitListeners: Array<
    (exit: { exitCode: number; signal: number | null }) => void
  > = []
  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener)
  }
  onExit(listener: (exit: { exitCode: number; signal: number | null }) => void): void {
    this.exitListeners.push(listener)
  }
  write(data: string): void {
    this.written.push(data)
  }
  resize(cols: number, rows: number): void {
    this.resized.push([cols, rows])
  }
  emit(data: string): void {
    for (const listener of this.dataListeners) listener(data)
  }
  exit(exitCode: number, signal: number | null = null): void {
    for (const listener of this.exitListeners) listener({ exitCode, signal })
  }
}

interface Spawned {
  file: string
  args: string[]
  options: PtySpawnOptions
  pty: FakePty
}

let dir: string
let workdir: string
let services: Services
let agents: AgentServices
let spawned: Spawned[]
let launches: LaunchInput[]
let kills: TerminationPlan[]
let extraFiles: Array<{ name: string; content: string }>
let unavailable: string | null

const platform = toPlatformId()

function fakeAdapter(): ProviderAdapter {
  return {
    id: 'fake',
    displayName: 'Fake',
    capabilities: { simulated: false, supportsModelSelection: false, permissionModes: ['default'] },
    observation: { kind: 'hooks', source: 'reported', parse: parseClaudeHook },
    detect: async () =>
      unavailable
        ? { found: false, path: null, version: null, problem: unavailable }
        : { found: true, path: '/bin/fake-agent', version: '1.0.0', problem: null },
    buildLaunch(input) {
      launches.push(input)
      return {
        file: input.executable,
        args: ['--flag'],
        env: { FROM_ADAPTER: 'yes' },
        inheritEnv: ['ADAPTER_AUTH', 'NOT_SET_ANYWHERE'],
        files: [{ name: 'note.txt', content: 'hello' }, ...extraFiles],
      }
    },
  }
}

beforeEach(async () => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'shokuba-runtime-')))
  workdir = join(dir, 'work')
  mkdirSync(workdir)
  spawned = []
  launches = []
  kills = []
  extraFiles = []
  unavailable = null

  services = createServices({
    dataDir: join(dir, 'data'),
    version: 'test',
    platform,
    logger: createLogger(() => {}),
  })
  agents = await createAgentServices(services, {
    platform,
    env: {
      PATH: '/usr/bin',
      HOME: '/home/u',
      AWS_SECRET_ACCESS_KEY: 'do-not-leak',
      ELECTRON_RUN_AS_NODE: '1',
      ADAPTER_AUTH: 'the-providers-own-credential',
    },
    home: '/home/u',
    providers: new ProviderRegistry([fakeAdapter()]),
    gracefulStopMs: 40,
    pasteSettleMs: 5,
    spawnPty: (file, args, options) => {
      const pty = new FakePty()
      spawned.push({ file, args, options, pty })
      return pty
    },
  })
  // Replace real signals with a recorder; FakePty is not a real process.
  ;(agents.runtime as unknown as { killProcess: (plan: TerminationPlan) => void }).killProcess = (
    plan,
  ) => {
    kills.push(plan)
  }
})

afterEach(async () => {
  await agents.hooks.close()
  agents.views.dispose()
  services.close()
  rmSync(dir, { recursive: true, force: true })
})

async function employee(overrides: Partial<Employee> = {}): Promise<Employee> {
  const created = await agents.employees.create({
    name: 'Mika',
    role: 'Engineer',
    providerId: 'fake',
    workingDirectory: workdir,
  })
  return { ...created, ...overrides }
}

/** Deliver a hook report the way Claude Code does: a real HTTP POST with the agent's token. */
async function report(payload: Record<string, unknown>, index = 0): Promise<number> {
  const launch = launches[index]
  const token = spawned[index]?.options.env[HOOK_TOKEN_ENV]
  if (!launch || !token) throw new Error('agent not started')
  const response = await fetch(launch.report.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  })
  return response.status
}

const eventsOf = (types?: string[]): ShokubaEvent[] =>
  services.events.log.list({ limit: 1000 }).filter((e) => !types || types.includes(e.type))

const stateChanges = (): string[] =>
  eventsOf(['agent.state.changed']).map((e) =>
    e.type === 'agent.state.changed' ? `${e.payload.from}>${e.payload.to}` : '',
  )

describe('AgentRuntime.start', () => {
  it("launches the provider in the employee's folder and reports it started", async () => {
    const mika = await employee()
    await agents.runtime.start(mika)

    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.file).toBe('/bin/fake-agent')
    expect(spawned[0]?.args).toEqual(['--flag'])
    expect(spawned[0]?.options.cwd).toBe(workdir)
    expect(agents.runtime.isRunning(mika.id)).toBe(true)

    expect(stateChanges()).toEqual(['offline>starting'])
    const started = eventsOf(['agent.started'])[0]
    expect(started).toMatchObject({
      source: 'system',
      actorId: mika.id,
      payload: { employeeId: mika.id, pid: 4242 },
    })
  })

  it("writes the adapter's files into a private run directory", async () => {
    const mika = await employee()
    await agents.runtime.start(mika)
    const runDir = launches[0]?.runDir ?? ''
    expect(runDir).toBe(join(dir, 'data', 'agents', mika.id))
    expect(readFileSync(join(runDir, 'note.txt'), 'utf8')).toBe('hello')
  })

  it('refuses adapter files that would escape the run directory', async () => {
    extraFiles = [{ name: '../escape.txt', content: 'x' }]
    const mika = await employee()
    await expect(agents.runtime.start(mika)).rejects.toMatchObject({ code: 'launch-failed' })
    expect(readdirSync(dir).includes('escape.txt')).toBe(false)
    expect(agents.runtime.isRunning(mika.id)).toBe(false)
    expect(spawned).toHaveLength(0)
  })

  it('gives the child a filtered environment plus its own report token', async () => {
    await agents.runtime.start(await employee())
    const env = spawned[0]?.options.env ?? {}
    expect(env['PATH']).toBe('/usr/bin')
    expect(env['FROM_ADAPTER']).toBe('yes')
    expect(env[HOOK_TOKEN_ENV]?.length).toBeGreaterThanOrEqual(40)
    // Neither secrets from the parent nor Shokuba's own runtime flags leak into the agent.
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined()
    expect(env['ELECTRON_RUN_AS_NODE']).toBeUndefined()
  })

  it('passes along exactly the variables the provider declares it needs, when they are set', async () => {
    await agents.runtime.start(await employee())
    const env = spawned[0]?.options.env ?? {}
    expect(env['ADAPTER_AUTH']).toBe('the-providers-own-credential')
    expect('NOT_SET_ANYWHERE' in env).toBe(false)
  })

  it('never writes the token to disk or into the launch description', async () => {
    const mika = await employee()
    await agents.runtime.start(mika)
    const token = spawned[0]?.options.env[HOOK_TOKEN_ENV] ?? ''
    for (const name of readdirSync(launches[0]?.runDir ?? '')) {
      expect(readFileSync(join(launches[0]?.runDir ?? '', name), 'utf8')).not.toContain(token)
    }
    expect(JSON.stringify(spawned[0]?.args)).not.toContain(token)
    expect(JSON.stringify(launches[0])).not.toContain(token)
    expect(JSON.stringify(eventsOf())).not.toContain(token)
  })

  it('records an audit entry', async () => {
    const mika = await employee()
    await agents.runtime.start(mika)
    const row = services.db
      .prepare("SELECT * FROM audit_log WHERE action = 'agent.start'")
      .get() as { target: string; detail: string }
    expect(row.target).toBe(mika.id)
    expect(JSON.parse(row.detail)).toMatchObject({
      provider: 'fake',
      workingDirectory: workdir,
      pid: 4242,
    })
  })

  it('will not start the same agent twice', async () => {
    const mika = await employee()
    await agents.runtime.start(mika)
    await expect(agents.runtime.start(mika)).rejects.toMatchObject({ code: 'already-running' })
    expect(spawned).toHaveLength(1)
  })

  it('will not start the same agent twice even when the calls race', async () => {
    const mika = await employee()
    const results = await Promise.allSettled([
      agents.runtime.start(mika),
      agents.runtime.start(mika),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(spawned).toHaveLength(1)
  })

  it('explains an unavailable provider, and does not spawn', async () => {
    unavailable = 'Fake was not found'
    const mika = await employee()
    await expect(agents.runtime.start(mika)).rejects.toMatchObject({
      code: 'provider-unavailable',
      message: 'Fake was not found',
    })
    expect(spawned).toHaveLength(0)
  })

  it('rejects an unknown provider and a vanished folder', async () => {
    const mika = await employee()
    await expect(agents.runtime.start({ ...mika, providerId: 'nope' })).rejects.toMatchObject({
      code: 'unknown-provider',
    })
    rmSync(workdir, { recursive: true })
    await expect(agents.runtime.start(mika)).rejects.toMatchObject({
      code: 'invalid-working-directory',
    })
  })

  it('cleans up and reports an error when the process cannot be spawned', async () => {
    const failing = await createAgentServices(services, {
      platform,
      env: {},
      home: '/home/u',
      providers: new ProviderRegistry([fakeAdapter()]),
      spawnPty: () => {
        throw new Error('posix_spawnp failed')
      },
    })
    const mika = await employee()
    await expect(failing.runtime.start(mika)).rejects.toMatchObject({ code: 'launch-failed' })
    expect(failing.runtime.isRunning(mika.id)).toBe(false)
    expect(stateChanges()).toEqual(['offline>starting', 'starting>error'])
    expect(eventsOf(['agent.error'])[0]?.payload).toMatchObject({ code: 'launch-failed' })
    await failing.hooks.close()
    failing.views.dispose()
  })
})

describe('AgentRuntime observation', () => {
  it('turns real hook reports into events and states', async () => {
    const mika = await employee()
    await agents.runtime.start(mika)

    expect(await report({ hook_event_name: 'SessionStart' })).toBe(200)
    expect(await report({ hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' })).toBe(200)
    await report({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_use_id: 't1',
      cwd: workdir,
      tool_input: { file_path: join(workdir, 'a.ts') },
    })
    await report({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_use_id: 't1',
      duration_ms: 12,
    })
    await report({ hook_event_name: 'Stop' })

    expect(stateChanges()).toEqual([
      'offline>starting',
      'starting>idle',
      'idle>thinking',
      'thinking>coding',
      'coding>thinking',
      'thinking>idle',
    ])
    const tool = eventsOf(['agent.tool.started'])[0]
    expect(tool).toMatchObject({
      source: 'reported',
      payload: { toolName: 'Edit', summary: 'Edit a.ts' },
    })
  })

  it('never records prompts or model output', async () => {
    await agents.runtime.start(await employee())
    await report({ hook_event_name: 'UserPromptSubmit', prompt: 'my ssn is 123-45-6789' })
    await report({ hook_event_name: 'Stop', last_assistant_message: 'the answer is forty-two' })
    const log = JSON.stringify(eventsOf())
    expect(log).not.toContain('123-45-6789')
    expect(log).not.toContain('forty-two')
  })

  it('redacts secrets inside tool summaries before they are stored', async () => {
    await agents.runtime.start(await employee())
    await report({ hook_event_name: 'UserPromptSubmit' })
    await report({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {
        command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456" https://x',
      },
    })
    expect(JSON.stringify(eventsOf())).not.toContain('abcdefghijklmnopqrstuvwxyz123456')
  })

  it('ignores reports it does not understand without disturbing the agent', async () => {
    await agents.runtime.start(await employee())
    const before = eventsOf().length
    expect(await report({ hook_event_name: 'BrandNewHook' })).toBe(200)
    expect(await report({ nonsense: true })).toBe(200)
    expect(eventsOf()).toHaveLength(before)
    expect(agents.runtime.isRunning(eventsOf(['agent.started'])[0]?.actorId ?? '')).toBe(true)
  })

  it('stops accepting reports once the agent has exited', async () => {
    const mika = await employee()
    await agents.runtime.start(mika)
    spawned[0]?.pty.exit(0)
    expect(await report({ hook_event_name: 'Stop' })).toBe(401)
  })

  it("keeps separate agents' reports separate", async () => {
    const a = await employee()
    const b = await agents.employees.create({
      name: 'Ren',
      role: 'QA',
      providerId: 'fake',
      workingDirectory: workdir,
    })
    await agents.runtime.start(a)
    await agents.runtime.start(b)
    await report({ hook_event_name: 'UserPromptSubmit' }, 1)
    const thinking = eventsOf(['agent.state.changed']).filter(
      (e) => e.type === 'agent.state.changed' && e.payload.to === 'thinking',
    )
    expect(thinking).toHaveLength(1)
    expect(thinking[0]?.actorId).toBe(b.id)
  })
})

describe('AgentRuntime terminal', () => {
  it('passes output to listeners and keeps a replayable scrollback', async () => {
    const mika = await employee()
    const seen: string[] = []
    agents.runtime.onTerminalData((id, data, offset) => seen.push(`${id}:${data}@${offset}`))
    await agents.runtime.start(mika)
    spawned[0]?.pty.emit('hello ')
    spawned[0]?.pty.emit('world')
    expect(seen).toEqual([`${mika.id}:hello @6`, `${mika.id}:world@11`])
    expect(agents.runtime.replay(mika.id)).toEqual({ data: 'hello world', offset: 11 })
  })

  it('forwards keystrokes and resizes', async () => {
    const mika = await employee()
    await agents.runtime.start(mika)
    agents.runtime.write(mika.id, 'ls\r')
    agents.runtime.resize(mika.id, 100, 30)
    expect(spawned[0]?.pty.written).toEqual(['ls\r'])
    expect(spawned[0]?.pty.resized).toEqual([[100, 30]])
  })

  it('rejects input for an agent that is not running', async () => {
    const mika = await employee()
    expect(() => agents.runtime.write(mika.id, 'x')).toThrow(AgentRuntimeError)
    expect(() => agents.runtime.interrupt(mika.id)).toThrow(/not running/)
  })

  it('remembers the terminal size while stopped and starts the next run at that size', async () => {
    const mika = await employee()
    agents.runtime.resize(mika.id, 91, 27)
    await agents.runtime.start(mika)
    expect(spawned[0]?.options).toMatchObject({ cols: 91, rows: 27 })
    // ...and a running agent is resized immediately.
    agents.runtime.resize(mika.id, 100, 30)
    expect(spawned[0]?.pty.resized).toEqual([[100, 30]])
  })

  it('sends Ctrl+C to interrupt, and shows the agent idle since Claude Code reports no interruption', async () => {
    const mika = await employee()
    await agents.runtime.start(mika)
    await report({ hook_event_name: 'UserPromptSubmit' })
    agents.runtime.interrupt(mika.id)
    expect(spawned[0]?.pty.written).toEqual(['\x03'])
    expect(stateChanges().at(-1)).toBe('thinking>idle')
    const change = eventsOf(['agent.state.changed']).at(-1)
    expect(change?.source).toBe('inferred')
  })

  it('treats a lone Escape typed in the terminal the same way', async () => {
    const mika = await employee()
    await agents.runtime.start(mika)
    await report({ hook_event_name: 'UserPromptSubmit' })
    agents.runtime.write(mika.id, '\x1b')
    expect(stateChanges().at(-1)).toBe('thinking>idle')
  })

  it('does not treat ordinary typing as an interruption', async () => {
    const mika = await employee()
    await agents.runtime.start(mika)
    await report({ hook_event_name: 'UserPromptSubmit' })
    agents.runtime.write(mika.id, 'keep going\r')
    expect(stateChanges().at(-1)).toBe('idle>thinking')
  })

  it('keeps the final output after exit so the panel can show why', async () => {
    const mika = await employee()
    await agents.runtime.start(mika)
    const output = 'fatal: something broke\r\n'
    spawned[0]?.pty.emit(output)
    spawned[0]?.pty.exit(1)
    expect(agents.runtime.replay(mika.id)).toEqual({ data: output, offset: output.length })
  })
})

describe('AgentRuntime exit and stop', () => {
  it('records an unexpected non-zero exit as an error', async () => {
    const mika = await employee()
    await agents.runtime.start(mika)
    spawned[0]?.pty.exit(2)
    expect(agents.runtime.isRunning(mika.id)).toBe(false)
    expect(stateChanges().at(-1)).toBe('starting>error')
    expect(eventsOf(['agent.stopped'])[0]?.payload).toEqual({
      employeeId: mika.id,
      exitCode: 2,
      signal: null,
    })
    expect(eventsOf(['agent.error'])[0]?.payload).toMatchObject({
      code: 'exited',
      message: 'exited with code 2',
    })
  })

  it('records a clean exit as stopped, with no error', async () => {
    const mika = await employee()
    await agents.runtime.start(mika)
    spawned[0]?.pty.exit(0)
    expect(stateChanges().at(-1)).toBe('starting>stopped')
    expect(eventsOf(['agent.error'])).toHaveLength(0)
  })

  it('names the signal when the process is killed', async () => {
    await agents.runtime.start(await employee())
    spawned[0]?.pty.exit(0, 9)
    expect(eventsOf(['agent.stopped'])[0]?.payload).toMatchObject({ signal: 'SIGKILL' })
  })

  it('stops gracefully, and does not report a requested stop as an error', async () => {
    const mika = await employee()
    await agents.runtime.start(mika)
    const stopping = agents.runtime.stop(mika.id)
    expect(kills.map((k) => k.kind)).toHaveLength(1)
    spawned[0]?.pty.exit(0, 15)
    await stopping
    expect(kills).toHaveLength(1)
    expect(stateChanges().at(-1)).toBe('starting>stopped')
    expect(eventsOf(['agent.error'])).toHaveLength(0)
  })

  it('escalates to a forced kill when the agent ignores the polite request', async () => {
    const mika = await employee()
    await agents.runtime.start(mika)
    const stopping = agents.runtime.stop(mika.id)
    await vi.waitFor(() => expect(kills).toHaveLength(2))
    const [graceful, force] = kills
    if (platform === 'win32') {
      expect(graceful).toMatchObject({ kind: 'taskkill' })
      expect((force as { args: string[] }).args).toContain('/F')
    } else {
      expect(graceful).toMatchObject({ kind: 'signal-group', pid: 4242, signal: 'SIGTERM' })
      expect(force).toMatchObject({ kind: 'signal-group', pid: 4242, signal: 'SIGKILL' })
    }
    spawned[0]?.pty.exit(0, 9)
    await stopping
  })

  it('stopping an agent that is not running is a no-op', async () => {
    await expect(agents.runtime.stop('nobody')).resolves.toBeUndefined()
    expect(kills).toHaveLength(0)
  })

  it('can be started again after it exits', async () => {
    const mika = await employee()
    await agents.runtime.start(mika)
    spawned[0]?.pty.exit(0)
    await agents.runtime.start(mika)
    expect(spawned).toHaveLength(2)
    expect(agents.runtime.replay(mika.id)).toEqual({ data: '', offset: 0 })
  })

  it('shutdown stops every running agent', async () => {
    const a = await employee()
    const b = await agents.employees.create({
      name: 'Ren',
      role: 'QA',
      providerId: 'fake',
      workingDirectory: workdir,
    })
    await agents.runtime.start(a)
    await agents.runtime.start(b)
    const done = agents.runtime.shutdown()
    await vi.waitFor(() => expect(kills.length).toBeGreaterThanOrEqual(2))
    for (const s of spawned) s.pty.exit(0, 15)
    await done
    expect(agents.runtime.isRunning(a.id)).toBe(false)
    expect(agents.runtime.isRunning(b.id)).toBe(false)
  })
})

describe('AgentViews', () => {
  it('reflects live agent state for a window that opens late', async () => {
    const mika = await employee()
    await agents.runtime.start(mika)
    await report({ hook_event_name: 'UserPromptSubmit' })
    await report({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_use_id: 't',
      tool_input: { file_path: '/x/a.ts' },
    })

    const { views, lastSeq } = agents.views.snapshot([mika.id])
    expect(views[0]).toMatchObject({
      employeeId: mika.id,
      state: 'coding',
      stateSource: 'reported',
      pid: 4242,
      activity: { toolName: 'Edit' },
    })
    expect(lastSeq).toBe(services.events.log.latestSeq())
  })

  it('shows a brand new employee as offline', async () => {
    const mika = await employee()
    expect(agents.views.snapshot([mika.id]).views[0]).toMatchObject({ state: 'offline', pid: null })
  })
})

describe('AgentRuntime prompt delivery', () => {
  const ESC = String.fromCharCode(27)

  /** Start an agent and get it to a reported-idle state, as Claude Code's SessionStart does. */
  async function idleAgent(): Promise<Employee> {
    const mika = await employee()
    await agents.runtime.start(mika)
    await report({ hook_event_name: 'SessionStart' })
    return mika
  }

  it('is not possible for an agent that is not running', async () => {
    const mika = await employee()
    expect(agents.runtime.deliveryBlocker(mika.id)).toBe('is not running')
    await expect(agents.runtime.deliverPrompt(mika.id, 'hi')).rejects.toMatchObject({
      code: 'not-running',
    })
  })

  it('is not possible while the agent is still starting up (it may be on a setup or login screen)', async () => {
    const mika = await employee()
    await agents.runtime.start(mika)
    expect(agents.runtime.deliveryBlocker(mika.id)).toBe('is starting, not idle')
    await expect(agents.runtime.deliverPrompt(mika.id, 'hi')).rejects.toMatchObject({
      code: 'not-ready',
    })
    expect(spawned[0]?.pty.written).toEqual([])
  })

  it('is possible once the agent has reported that it is idle', async () => {
    const mika = await idleAgent()
    expect(agents.runtime.deliveryBlocker(mika.id)).toBeNull()
  })

  it('is not possible while the agent is working or waiting on a permission prompt', async () => {
    const mika = await idleAgent()
    await report({ hook_event_name: 'UserPromptSubmit' })
    expect(agents.runtime.deliveryBlocker(mika.id)).toBe('is thinking, not idle')
    await report({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' })
    expect(agents.runtime.deliveryBlocker(mika.id)).toBe('is waiting, not idle')
    await expect(agents.runtime.deliverPrompt(mika.id, 'hi')).rejects.toMatchObject({
      code: 'not-ready',
    })
    // Nothing was typed into a terminal that might be showing a permission prompt.
    expect(spawned[0]?.pty.written).toEqual([])
  })

  it('is not possible when idle is only a guess (after an interrupt), until the agent reports', async () => {
    const mika = await idleAgent()
    await report({ hook_event_name: 'UserPromptSubmit' })
    agents.runtime.interrupt(mika.id)
    expect(agents.runtime.deliveryBlocker(mika.id)).toBe('looks idle, but that is only a guess')
    await report({ hook_event_name: 'UserPromptSubmit' })
    await report({ hook_event_name: 'Stop' })
    expect(agents.runtime.deliveryBlocker(mika.id)).toBeNull()
  })

  it('pastes the text as one block, then presses Enter', async () => {
    const mika = await idleAgent()
    await agents.runtime.deliverPrompt(mika.id, 'Do the thing\nand the other thing')
    expect(spawned[0]?.pty.written).toEqual([
      `${ESC}[200~Do the thing\nand the other thing${ESC}[201~`,
      '\r',
    ])
  })

  it('cannot be tricked into ending the paste early by text containing escape sequences', async () => {
    const mika = await idleAgent()
    await agents.runtime.deliverPrompt(mika.id, `harmless${ESC}[201~ rm -rf ~\r`)
    const [paste] = spawned[0]?.pty.written ?? []
    expect((paste ?? '').split(ESC).length - 1).toBe(2)
    expect(paste).toContain('[201~ rm -rf ~')
  })

  it('does not press Enter if the agent stopped while the text settled', async () => {
    const mika = await idleAgent()
    const delivery = agents.runtime.deliverPrompt(mika.id, 'hi')
    spawned[0]?.pty.exit(0)
    await expect(delivery).rejects.toMatchObject({ code: 'not-running' })
    expect(spawned[0]?.pty.written.includes('\r')).toBe(false)
  })

  it('leaves an audit entry, without the text', async () => {
    const mika = await idleAgent()
    await agents.runtime.deliverPrompt(mika.id, 'a secret briefing')
    const row = services.db
      .prepare("SELECT target, detail FROM audit_log WHERE action = 'agent.deliver'")
      .get() as { target: string; detail: string }
    expect(row.target).toBe(mika.id)
    expect(row.detail).not.toContain('secret')
  })
})

describe('AgentRuntime tools endpoint', () => {
  async function callTool(index: number, name: string, args: object = {}): Promise<string> {
    const launch = launches[index]
    const token = spawned[index]?.options.env[HOOK_TOKEN_ENV]
    if (!launch || !token) throw new Error('agent not started')
    const response = await fetch(launch.report.mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
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

  it('gives each agent its own MCP URL and answers as that agent', async () => {
    const a = await employee()
    const b = await agents.employees.create({
      name: 'Ren',
      role: 'QA',
      providerId: 'fake',
      workingDirectory: workdir,
    })
    await agents.runtime.start(a)
    await agents.runtime.start(b)
    expect(launches[0]?.report.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)

    const mission = agents.missions.createMission({ title: 'M' })
    agents.missions.missionAction(mission.id, 'run')
    const task = agents.missions.createTask({
      missionId: mission.id,
      title: 'Only Ren',
      assigneeId: b.id,
    })
    agents.missions.markDispatched(task.id)

    // The same question, asked over two different agents' connections, gets different answers:
    // who is asking comes from the token, never from the message.
    expect(await callTool(0, 'get_current_task')).toBe('You have no task in progress.')
    expect(await callTool(1, 'get_current_task')).toContain('Only Ren')
  })
})

describe('AgentRuntime, one delivery at a time', () => {
  async function idleAgent(): Promise<Employee> {
    const mika = await employee()
    await agents.runtime.start(mika)
    await report({ hook_event_name: 'SessionStart' })
    return mika
  }

  it('does not accept a second delivery until the agent has started a turn on the first', async () => {
    const mika = await idleAgent()
    await agents.runtime.deliverPrompt(mika.id, 'first')
    expect(agents.runtime.deliveryBlocker(mika.id)).toBe('is still receiving something')
    await expect(agents.runtime.deliverPrompt(mika.id, 'second')).rejects.toMatchObject({
      code: 'not-ready',
    })
    expect(spawned[0]?.pty.written.filter((w) => w === '\r')).toHaveLength(1)
  })

  it('accepts the next delivery once the agent reports starting to work on the first', async () => {
    const mika = await idleAgent()
    await agents.runtime.deliverPrompt(mika.id, 'first')
    await report({ hook_event_name: 'UserPromptSubmit' })
    await report({ hook_event_name: 'Stop' })
    expect(agents.runtime.deliveryBlocker(mika.id)).toBeNull()
  })

  it('does not stay blocked forever if the agent never reports', async () => {
    vi.useFakeTimers()
    try {
      const mika = await idleAgent()
      const delivery = agents.runtime.deliverPrompt(mika.id, 'first')
      await vi.advanceTimersByTimeAsync(10)
      await delivery
      expect(agents.runtime.deliveryBlocker(mika.id)).toBe('is still receiving something')
      await vi.advanceTimersByTimeAsync(6_000)
      expect(agents.runtime.deliveryBlocker(mika.id)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('frees the agent again if the paste itself fails', async () => {
    const mika = await idleAgent()
    spawned[0]?.pty.exit(0)
    await expect(agents.runtime.deliverPrompt(mika.id, 'x')).rejects.toBeDefined()
  })
})
