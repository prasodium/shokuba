import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Mission } from '@shared/missions'
import { createMissionFixture, type MissionFixture } from '../missions/fixtures'
import {
  AGENT_TOOL_NAMES,
  AGENT_TOOL_PERMISSIONS,
  createAgentTools,
  type AgentToolContext,
} from './agent-tools'
import { McpEndpoint } from './server'

let fx: MissionFixture
let mission: Mission
let mcp: McpEndpoint<AgentToolContext>

beforeEach(() => {
  fx = createMissionFixture()
  fx.addEmployee('mika')
  fx.addEmployee('ren')
  mission = fx.missions.createMission({ title: 'M' })
  fx.missions.missionAction(mission.id, 'run')
  mcp = new McpEndpoint({ name: 'shokuba', version: 't' }, createAgentTools(fx.missions))
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
    expect([...AGENT_TOOL_NAMES]).toEqual(['get_current_task', 'submit_task', 'report_blocked'])
    expect(AGENT_TOOL_PERMISSIONS).toEqual([
      'mcp__shokuba__get_current_task',
      'mcp__shokuba__submit_task',
      'mcp__shokuba__report_blocked',
    ])
    const names = createAgentTools(fx.missions).map((tool) => tool.name)
    expect(names).toEqual([...AGENT_TOOL_NAMES])
  })

  it('describe themselves for the model', () => {
    for (const tool of createAgentTools(fx.missions)) {
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
})
