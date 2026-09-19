import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Mission } from '@shared/missions'
import { createMissionFixture, type MissionFixture } from '../missions/fixtures'
import {
  AGENT_TOOL_NAMES,
  AGENT_TOOL_PERMISSIONS,
  createAgentTools,
  type AgentToolContext,
} from './agent-tools'
import { MessageService } from '../messages/service'
import { McpEndpoint } from './server'

let fx: MissionFixture
let mission: Mission
let mcp: McpEndpoint<AgentToolContext>
let messages: MessageService
const team = {
  list: () => [
    { id: 'mika', name: 'mika', role: 'Engineer' },
    { id: 'ren', name: 'ren', role: 'Engineer' },
  ],
  isRunning: (id: string) => id === 'mika',
}
const tools = () => createAgentTools(fx.missions, messages, team)

beforeEach(() => {
  fx = createMissionFixture()
  fx.addEmployee('mika')
  fx.addEmployee('ren')
  mission = fx.missions.createMission({ title: 'M' })
  fx.missions.missionAction(mission.id, 'run')
  messages = new MessageService({
    db: fx.services.db,
    events: fx.services.events,
    directory: team,
    taskMissionId: (id) => fx.missions.getTask(id)?.missionId,
  })
  mcp = new McpEndpoint({ name: 'shokuba', version: 't' }, tools())
})

afterEach(() => fx.cleanup())

/** Call a tool as `employeeId`, as the HTTP layer does. Returns the text and whether it was an error. */
async function callTool(
  employeeId: string,
  name: string,
  args: Record<string, unknown> = {},
  source: AgentToolContext['source'] = 'reported',
): Promise<{ text: string; isError: boolean }> {
  const reply = await mcp.handle(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { employeeId, source },
  )
  const result = reply?.result as { content: Array<{ text: string }>; isError?: boolean }
  return { text: result.content[0]?.text ?? '', isError: result.isError === true }
}

const handOut = (title: string, assigneeId: string) => {
  const task = fx.missions.createTask({ missionId: mission.id, title, assigneeId })
  fx.missions.markDispatched(task.id)
  return task
}

describe('agent tools', () => {
  it('are the three the adapter pre-approves, under the shokuba server name', () => {
    expect([...AGENT_TOOL_NAMES]).toEqual([
      'get_current_task',
      'submit_task',
      'report_blocked',
      'list_teammates',
      'send_message',
    ])
    expect(AGENT_TOOL_PERMISSIONS).toEqual([
      'mcp__shokuba__get_current_task',
      'mcp__shokuba__submit_task',
      'mcp__shokuba__report_blocked',
      'mcp__shokuba__list_teammates',
      'mcp__shokuba__send_message',
    ])
    const names = tools().map((tool) => tool.name)
    expect(names).toEqual([...AGENT_TOOL_NAMES])
  })

  it('describe themselves for the model', () => {
    for (const tool of tools()) {
      expect(tool.description.length).toBeGreaterThan(30)
      expect(tool.inputSchema['type']).toBe('object')
    }
  })

  describe('get_current_task', () => {
    it('returns the briefing for the task this agent was handed', async () => {
      const task = handOut('Write tests', 'mika')
      const { text, isError } = await callTool('mika', 'get_current_task')
      expect(isError).toBe(false)
      expect(text).toContain('[Shokuba task]')
      expect(text).toContain('Write tests')
      expect(text).toContain(task.id)
    })

    it("says so when there is nothing to do, and shows nobody else's task", async () => {
      handOut("Ren's task", 'ren')
      expect((await callTool('mika', 'get_current_task')).text).toBe(
        'You have no task in progress.',
      )
    })
  })

  describe('submit_task', () => {
    it('makes the task submitted — a claim awaiting review, not done', async () => {
      const task = handOut('A', 'mika')
      const { text, isError } = await callTool('mika', 'submit_task', {
        summary: 'All done, tests pass',
      })
      expect(isError).toBe(false)
      expect(text).toContain('waiting for a person')
      expect(fx.missions.getTask(task.id)).toMatchObject({
        status: 'submitted',
        summary: 'All done, tests pass',
      })
    })

    it('works with or without the task id', async () => {
      const task = handOut('A', 'mika')
      expect(
        (await callTool('mika', 'submit_task', { taskId: task.id, summary: 'ok' })).isError,
      ).toBe(false)
    })

    it('labels the change with how we know: reported, or simulated for the demo agent', async () => {
      handOut('A', 'mika')
      await callTool('mika', 'submit_task', { summary: 'ok' }, 'simulated')
      expect(fx.eventsOf('task.status.changed').at(-1)).toMatchObject({
        source: 'simulated',
        actorId: 'mika',
      })
    })

    it('tells the model when it has nothing to submit, so it can stop', async () => {
      const { text, isError } = await callTool('mika', 'submit_task', { summary: 'x' })
      expect(isError).toBe(true)
      expect(text).toBe('You have no task in progress')
    })

    it("refuses to touch another agent's task, whatever id it names", async () => {
      const rens = handOut("Ren's", 'ren')
      const { text, isError } = await callTool('mika', 'submit_task', {
        taskId: rens.id,
        summary: 'mine now',
      })
      expect(isError).toBe(true)
      expect(text).toBe('That task is not yours')
      expect(fx.missions.getTask(rens.id)?.status).toBe('in_progress')
    })

    it('asks for a summary and explains what was wrong with the arguments', async () => {
      handOut('A', 'mika')
      const empty = await callTool('mika', 'submit_task', { summary: '' })
      expect(empty.isError).toBe(true)
      expect(empty.text).toContain('summary')
      const missing = await callTool('mika', 'submit_task', {})
      expect(missing.isError).toBe(true)
      expect(missing.text).toContain('Invalid arguments')
    })
  })

  describe('report_blocked', () => {
    it('marks the task blocked with the reason, for a person to decide', async () => {
      const task = handOut('A', 'mika')
      const { isError } = await callTool('mika', 'report_blocked', { reason: 'No database access' })
      expect(isError).toBe(false)
      expect(fx.missions.getTask(task.id)).toMatchObject({
        status: 'blocked',
        blockedReason: 'No database access',
      })
    })

    it("cannot block another agent's task", async () => {
      const rens = handOut("Ren's", 'ren')
      const { isError } = await callTool('mika', 'report_blocked', {
        taskId: rens.id,
        reason: 'sabotage',
      })
      expect(isError).toBe(true)
      expect(fx.missions.getTask(rens.id)?.status).toBe('in_progress')
    })
  })

  it('shows the model nothing internal when something unexpected goes wrong', async () => {
    handOut('A', 'mika')
    fx.services.db.exec('DROP TABLE task_dependencies')
    const { text, isError } = await callTool('mika', 'get_current_task')
    expect(isError).toBe(true)
    expect(text).toBe('The tool failed.')
  })

  describe('list_teammates', () => {
    it('lists everyone else with role, id and whether they run, and how to reach the person', async () => {
      const { text, isError } = await callTool('mika', 'list_teammates')
      expect(isError).toBe(false)
      expect(text).toContain('ren (Engineer) — id ren — not running')
      expect(text).not.toContain('mika (Engineer)')
      expect(text).toContain('to: "human"')
    })
  })

  describe('send_message', () => {
    it('sends to a teammate by name, and tells the model not to wait', async () => {
      const { text, isError } = await callTool('mika', 'send_message', {
        to: 'ren',
        subject: 'API contract',
        body: 'Is /login a POST?',
        kind: 'question',
      })
      expect(isError).toBe(false)
      expect(text).toContain('Sent')
      expect(text).toContain('Do not wait')
      expect(messages.queuedFor('ren')[0]).toMatchObject({
        fromId: 'mika',
        subject: 'API contract',
        kind: 'question',
      })
    })

    it('can reach the person', async () => {
      const { text, isError } = await callTool('mika', 'send_message', {
        to: 'human',
        subject: 'Decision',
        body: 'A or B?',
      })
      expect(isError).toBe(false)
      expect(text).toContain('person you work for')
    })

    it('tells the model plainly when it cannot send', async () => {
      const nobody = await callTool('mika', 'send_message', {
        to: 'nobody',
        subject: 's',
        body: 'b',
      })
      expect(nobody.isError).toBe(true)
      expect(nobody.text).toContain('list_teammates')
      const self = await callTool('mika', 'send_message', { to: 'mika', subject: 's', body: 'b' })
      expect(self.isError).toBe(true)
      expect(self.text).toContain('yourself')
    })

    it('asks for the fields it needs', async () => {
      const { text, isError } = await callTool('mika', 'send_message', { to: 'ren' })
      expect(isError).toBe(true)
      expect(text).toContain('Invalid arguments')
    })

    it('says a held message was NOT delivered, so the model stops', async () => {
      // Drive a chain to the hop limit, as two agents answering each other would.
      await callTool('mika', 'send_message', { to: 'ren', subject: 'ping', body: 'ping' })
      let result = { text: '', isError: false }
      for (let hop = 2; hop <= 8; hop++) {
        const from = hop % 2 === 0 ? 'ren' : 'mika'
        const to = hop % 2 === 0 ? 'mika' : 'ren'
        messages.markDelivered(messages.queuedFor(from), 'paste')
        result = await callTool(from, 'send_message', { to, subject: 'pong', body: 'pong' })
        if (result.isError) break
      }
      expect(result.isError).toBe(true)
      expect(result.text).toContain('Not delivered')
      expect(result.text).toContain('Do not send more')
    })

    it('identifies the sender from the connection, not from the message', async () => {
      await callTool('mika', 'send_message', {
        to: 'ren',
        subject: 's',
        body: 'b',
        from: 'ren',
        fromId: 'ren',
      })
      expect(messages.queuedFor('ren')[0]?.fromId).toBe('mika')
    })
  })
})
