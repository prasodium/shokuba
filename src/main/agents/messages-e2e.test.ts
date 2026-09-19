import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Employee } from '@shared/employees'
import { HUMAN, MAX_HOPS } from '@shared/messages'
import { createServices, type Services } from '../bootstrap'
import { createLogger } from '../logging/logger'
import { toPlatformId } from '../platform'
import { parseClaudeHook } from '../providers/claude-code/hooks'
import { ProviderRegistry } from '../providers/registry'
import type { LaunchInput, ProviderAdapter } from '../providers/types'
import { createAgentServices, type AgentServices } from './index'
import type { PtyProcess, PtySpawnOptions } from './pty'
import { HOOK_TOKEN_ENV } from './runtime'

class FakePty implements PtyProcess {
  readonly written: string[] = []
  constructor(readonly pid: number) {}
  onData(): void {}
  onExit(): void {}
  write(data: string): void {
    this.written.push(data)
  }
  resize(): void {}
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

// Same shape as the real Claude Code adapter: hooks in, a Stop continuation out.
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

beforeEach(async () => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'shokuba-msg-e2e-')))
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
      const pty = new FakePty(2000 + spawns.length)
      spawns.push({ pty, options })
      return pty
    },
  })
})

afterEach(async () => {
  agents.router.stop()
  agents.dispatcher.stop()
  await agents.hooks.close()
  agents.views.dispose()
  services.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Hire an employee, start their agent, and have it report in like Claude Code's SessionStart. */
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

/** Send a hook report; returns what Shokuba answered (a Stop may carry a continuation). */
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

const stateOf = (agent: Agent): string =>
  agents.views.snapshot([agent.employee.id]).views[0]?.state ?? 'unknown'
const typed = (agent: Agent): string => agent.pty.written.join('')

describe('messages, end to end', () => {
  it('delivers to a busy agent when its turn ends, as a continuation and without typing anything', async () => {
    const ren = await hire('Ren', 'Reviewer')
    await hook(ren, { hook_event_name: 'UserPromptSubmit' }) // Ren is working on something

    agents.messages.sendFromHuman({
      toId: ren.employee.id,
      subject: 'Priorities',
      body: 'Look at the login PR first.',
    })

    // Ren is busy: nothing is pasted into their terminal.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(ren.pty.written).toEqual([])

    // Ren's turn ends. The answer to that very report carries the message.
    const answer = await hook(ren, { hook_event_name: 'Stop' })
    expect(answer['decision']).toBe('block')
    expect(String(answer['reason'])).toContain('Look at the login PR first.')
    expect(String(answer['reason'])).toContain('From: the person you work for')

    // Ren carries straight on, and is shown working, though no prompt was submitted.
    expect(stateOf(ren)).toBe('thinking')
    expect(ren.pty.written).toEqual([])
    const delivered = services.events.log.list({ type: 'message.delivered' })
    expect(delivered[0]?.payload).toMatchObject({ via: 'continuation' })
  })

  it('pastes to an agent that is already idle, under the same rules as tasks', async () => {
    const mika = await hire('Mika')
    const ren = await hire('Ren', 'Reviewer')
    await hook(mika, { hook_event_name: 'UserPromptSubmit' })

    const sent = await tool(mika, 'send_message', {
      to: 'Ren',
      subject: 'Contract',
      body: 'Is /login a POST?',
      kind: 'question',
    })
    expect(sent.isError).toBe(false)

    await vi.waitFor(() => expect(ren.pty.written.at(-1)).toBe('\r'))
    expect(typed(ren)).toContain('Is /login a POST?')
    expect(typed(ren)).toContain('From: Mika (Engineer), a teammate agent')
    expect(typed(mika)).toBe('') // nothing typed into the sender
    const delivered = services.events.log.list({ type: 'message.delivered' })
    expect(delivered.at(-1)?.payload).toMatchObject({ via: 'paste' })
  })

  it('never pastes into an agent waiting on a permission prompt; it waits and is continued later', async () => {
    const mika = await hire('Mika')
    const ren = await hire('Ren', 'Reviewer')
    await hook(ren, { hook_event_name: 'UserPromptSubmit' })
    await hook(ren, { hook_event_name: 'PermissionRequest', tool_name: 'Bash' })
    await hook(mika, { hook_event_name: 'UserPromptSubmit' })
    await tool(mika, 'send_message', { to: 'Ren', subject: 's', body: 'urgent question' })

    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(ren.pty.written).toEqual([])
    expect(stateOf(ren)).toBe('waiting')
    // The person answers the prompt; the tool finishes; the turn ends; only then does it arrive.
    await hook(ren, { hook_event_name: 'PostToolUse', tool_name: 'Bash' })
    const answer = await hook(ren, { hook_event_name: 'Stop' })
    expect(String(answer['reason'])).toContain('urgent question')
  })

  it('treats what an agent sends while answering as a reply, so a chain of replies is counted', async () => {
    const mika = await hire('Mika')
    const ren = await hire('Ren', 'Reviewer')
    await hook(mika, { hook_event_name: 'UserPromptSubmit' })
    await tool(mika, 'send_message', { to: 'Ren', subject: 'Q', body: 'question' })
    await hook(mika, { hook_event_name: 'Stop' })
    await vi.waitFor(() => expect(ren.pty.written.at(-1)).toBe('\r'))
    await vi.waitFor(() =>
      expect(services.events.log.list({ type: 'message.delivered' })).toHaveLength(1),
    )

    await hook(ren, { hook_event_name: 'UserPromptSubmit' })
    await tool(ren, 'send_message', { to: 'Mika', subject: 'Re: Q', body: 'answer' })

    const conversation = agents.messages.listConversations()[0]
    expect(conversation?.messages.map((m) => m.hop)).toEqual([1, 2])
    expect(conversation?.messages[1]?.parentId).toBe(conversation?.messages[0]?.id)
  })

  it('stops a runaway exchange at the hop limit, holds it, and lets a person resume it', async () => {
    const mika = await hire('Mika')
    const ren = await hire('Ren', 'Reviewer')
    const pair = [mika, ren] as const

    // Two agents that answer each other forever. Each turn: start, reply, finish.
    let turn = 0
    let last: { text: string; isError: boolean } = { text: '', isError: false }
    let sender: Agent = mika
    while (turn < MAX_HOPS + 3) {
      const other = sender === mika ? ren : mika
      await hook(sender, { hook_event_name: 'UserPromptSubmit' })
      last = await tool(sender, 'send_message', {
        to: other.employee.name,
        subject: 'ping',
        body: `round ${turn}`,
      })
      if (last.isError) break
      await hook(sender, { hook_event_name: 'Stop' })
      // The recipient is idle, so the router pastes the message; wait for it to arrive.
      await vi.waitFor(() =>
        expect(services.events.log.list({ type: 'message.delivered' })).toHaveLength(turn + 1),
      )
      sender = other
      turn += 1
    }

    // It ran MAX_HOPS messages, then the next was refused and told to stop.
    expect(turn).toBe(MAX_HOPS)
    expect(last.isError).toBe(true)
    expect(last.text).toContain('Not delivered')
    expect(last.text).toContain('Do not send more')

    const conversation = agents.messages.listConversations()[0]
    expect(conversation?.conversation.status).toBe('halted')
    expect(conversation?.messages).toHaveLength(MAX_HOPS + 1)
    const held = conversation?.messages.at(-1)
    expect(held).toMatchObject({ state: 'held', hop: MAX_HOPS + 1 })
    expect(services.events.log.list({ type: 'message.held' })).toHaveLength(1)
    // The held message was never typed into anyone's terminal.
    expect(typed(pair[0]) + typed(pair[1])).not.toContain(`round ${MAX_HOPS}`)

    // The person resumes: the held message is released to its recipient, who can carry on.
    agents.messages.resume(held?.conversationId ?? '')
    const recipient = held?.toId === mika.employee.id ? mika : ren
    await hook(sender === recipient ? recipient : recipient, { hook_event_name: 'Stop' }).catch(
      () => undefined,
    )
    await vi.waitFor(() =>
      expect(agents.messages.getMessage(held?.id ?? '')?.state).toBe('delivered'),
    )
    expect(typed(recipient)).toContain(`round ${MAX_HOPS}`)
  })

  it('lets an agent reach the person, and the person answer', async () => {
    const mika = await hire('Mika')
    await hook(mika, { hook_event_name: 'UserPromptSubmit' })
    const sent = await tool(mika, 'send_message', {
      to: 'human',
      subject: 'Decision needed',
      body: 'SQLite or Postgres?',
      kind: 'question',
    })
    expect(sent.isError).toBe(false)

    const inbox = agents.messages.listConversations()[0]
    expect(inbox?.messages[0]).toMatchObject({ toId: HUMAN, state: 'delivered', readAt: null })
    // Nothing was typed into any terminal: it waits in the person's inbox.
    expect(typed(mika)).toBe('')

    agents.messages.markRead(inbox?.conversation.id ?? '')
    await hook(mika, { hook_event_name: 'Stop' })
    agents.messages.sendFromHuman({
      toId: mika.employee.id,
      subject: 'Re: Decision needed',
      body: 'SQLite.',
      conversationId: inbox?.conversation.id ?? null,
    })
    await vi.waitFor(() => expect(mika.pty.written.at(-1)).toBe('\r'))
    expect(typed(mika)).toContain('SQLite.')
  })

  it('lists teammates over the wire, never including the caller', async () => {
    const mika = await hire('Mika')
    await hire('Ren', 'Reviewer')
    const { text } = await tool(mika, 'list_teammates')
    expect(text).toContain('Ren (Reviewer)')
    expect(text).not.toContain('Mika (Engineer)')
  })
})
