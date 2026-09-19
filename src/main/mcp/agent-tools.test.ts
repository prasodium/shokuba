import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_QUEUED_PER_RECIPIENT } from '@shared/messages'
import type { Mission } from '@shared/missions'
import type { Review, ReviewSubmit } from '@shared/reviews'
import { createMissionFixture, type MissionFixture } from '../missions/fixtures'
import {
  AGENT_TOOL_NAMES,
  AGENT_TOOL_PERMISSIONS,
  MANAGER_TOOL_NAMES,
  MANAGER_TOOL_PERMISSIONS,
  REVIEW_TOOL_NAMES,
  REVIEW_TOOL_PERMISSIONS,
  createAgentTools,
  type AgentToolContext,
} from './agent-tools'
import { MessageService } from '../messages/service'
import { ReviewError } from '../reviews/service'
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
  it("are the five every agent has, plus a manager's and a reviewer's, under the shokuba server name", () => {
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
    expect(MANAGER_TOOL_PERMISSIONS).toEqual(MANAGER_TOOL_NAMES.map((n) => `mcp__shokuba__${n}`))
    const names = tools().map((tool) => tool.name)
    expect(REVIEW_TOOL_PERMISSIONS).toEqual(REVIEW_TOOL_NAMES.map((n) => `mcp__shokuba__${n}`))
    expect(names).toEqual([...AGENT_TOOL_NAMES, ...MANAGER_TOOL_NAMES, ...REVIEW_TOOL_NAMES])
  })

  it("offer the manager's and the reviewer's tools only to those they are for: each is gated, and no other is", () => {
    for (const tool of tools()) {
      const gated =
        (MANAGER_TOOL_NAMES as readonly string[]).includes(tool.name) ||
        (REVIEW_TOOL_NAMES as readonly string[]).includes(tool.name)
      expect(typeof tool.visibleTo === 'function', tool.name).toBe(gated)
    }
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

    it('is refused while the circuit breaker limits the sender, but can still reach the person', async () => {
      const limited = new McpEndpoint(
        { name: 'shokuba', version: 't' },
        createAgentTools(fx.missions, messages, {
          ...team,
          messageBlocker: (id) => (id === 'mika' ? 'Shokuba has limited you (a loop)' : null),
        }),
      )
      const call = async (from: string, args: Record<string, unknown>) => {
        const reply = await limited.handle(
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'send_message', arguments: args },
          },
          { employeeId: from, source: 'reported' },
        )
        const result = reply?.result as { content: Array<{ text: string }>; isError?: boolean }
        return { text: result.content[0]?.text ?? '', isError: result.isError === true }
      }

      const refused = await call('mika', { to: 'ren', subject: 's', body: 'b' })
      expect(refused.isError).toBe(true)
      expect(refused.text).toContain('limited you')
      expect(messages.queuedFor('ren')).toEqual([])

      expect((await call('mika', { to: 'human', subject: 's', body: 'help' })).isError).toBe(false)
      expect((await call('ren', { to: 'mika', subject: 's', body: 'b' })).isError).toBe(false)
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

describe('agent tools on a team with a manager', () => {
  const squad = {
    list: () => [
      { id: 'mira', name: 'Mira', role: 'Manager', isManager: true, reportsTo: null },
      { id: 'sora', name: 'Sora', role: 'QA', isManager: false, reportsTo: 'mira' },
      { id: 'mika', name: 'Mika', role: 'Engineer', isManager: false, reportsTo: null },
    ],
    isRunning: () => true,
  }
  let limited: Set<string>

  beforeEach(() => {
    fx.addEmployee('mira', 'Mira', 'Manager')
    fx.addEmployee('sora', 'Sora', 'QA')
    limited = new Set()
    messages = new MessageService({
      db: fx.services.db,
      events: fx.services.events,
      directory: squad,
      taskMissionId: (id) => fx.missions.getTask(id)?.missionId,
    })
    mcp = new McpEndpoint(
      { name: 'shokuba', version: 't' },
      createAgentTools(fx.missions, messages, {
        ...squad,
        messageBlocker: (id) => (limited.has(id) ? 'Shokuba has limited you' : null),
      }),
    )
  })

  describe('list_teammates', () => {
    it('shows an employee who their manager is, and that they go through them', async () => {
      const { text } = await callTool('sora', 'list_teammates')
      expect(text).toContain('Mira (Manager) — your manager')
      expect(text).toContain('You report to Mira')
      expect(text).toContain('ask Mira')
      expect(text).not.toContain('to: "human"')
    })

    it('shows a manager who reports to them, and that they are the one who talks to the person', async () => {
      const { text } = await callTool('mira', 'list_teammates')
      expect(text).toContain('Sora (QA) — reports to you')
      expect(text).toContain('to: "human"')
      expect(text).toContain('you are the one who talks to them for your team')
    })

    it('leaves someone with no manager with the person as their contact', async () => {
      const { text } = await callTool('mika', 'list_teammates')
      expect(text).toContain('Mira (Manager) — a manager')
      expect(text).toContain('to: "human"')
    })
  })

  describe('send_message', () => {
    it('refuses an employee who reports to a manager when they write to the person, and says what to do', async () => {
      const { text, isError } = await callTool('sora', 'send_message', {
        to: 'human',
        subject: 'Decision',
        body: 'A or B?',
      })
      expect(isError).toBe(true)
      expect(text).toContain('You report to Mira')
      expect(text).toContain('to: "Mira"')
    })

    it('carries an employee’s question to their manager, and the manager onward to the person', async () => {
      const up = await callTool('sora', 'send_message', {
        to: 'Mira',
        subject: 'For the person',
        body: 'A or B?',
        kind: 'question',
      })
      expect(up.isError).toBe(false)
      expect(messages.queuedFor('mira')[0]).toMatchObject({ fromId: 'sora', body: 'A or B?' })

      const onward = await callTool('mira', 'send_message', {
        to: 'human',
        subject: 'The team asks',
        body: 'A or B?',
      })
      expect(onward.isError).toBe(false)
      expect(onward.text).toContain('person you work for')
    })

    it('lets a limited employee still reach their manager, but not a teammate or the person', async () => {
      limited.add('sora')
      const toManager = await callTool('sora', 'send_message', {
        to: 'Mira',
        subject: 's',
        body: 'help',
      })
      expect(toManager.isError).toBe(false)
      const toById = await callTool('sora', 'send_message', {
        to: 'mira',
        subject: 's',
        body: 'help',
      })
      expect(toById.isError).toBe(false)
      const toTeammate = await callTool('sora', 'send_message', {
        to: 'Mika',
        subject: 's',
        body: 'x',
      })
      expect(toTeammate).toMatchObject({ isError: true })
      expect(toTeammate.text).toContain('limited you')
      // The person is not reachable directly for someone with a manager, limited or not.
      const toPerson = await callTool('sora', 'send_message', {
        to: 'human',
        subject: 's',
        body: 'x',
      })
      expect(toPerson.text).toContain('limited you')
    })

    it('lets a limited employee with no manager still reach the person', async () => {
      limited.add('mika')
      expect(
        (await callTool('mika', 'send_message', { to: 'human', subject: 's', body: 'help' }))
          .isError,
      ).toBe(false)
      expect(
        (await callTool('mika', 'send_message', { to: 'Sora', subject: 's', body: 'x' })).isError,
      ).toBe(true)
    })
  })

  describe('report_blocked', () => {
    it('also tells the employee’s manager, and says so', async () => {
      const task = fx.missions.createTask({
        missionId: mission.id,
        title: 'Test login',
        assigneeId: 'sora',
      })
      fx.missions.markDispatched(task.id)
      const { text, isError } = await callTool('sora', 'report_blocked', {
        reason: 'No test database',
      })
      expect(isError).toBe(false)
      expect(text).toContain('Mira, your manager, has been told')
      const told = messages.queuedFor('mira')
      expect(told).toHaveLength(1)
      expect(told[0]).toMatchObject({
        fromId: 'sora',
        kind: 'warning',
        subject: 'Blocked: Test login',
        body: 'No test database',
        taskId: task.id,
      })
    })

    it('says nothing about a manager for someone who has none', async () => {
      const task = fx.missions.createTask({ missionId: mission.id, title: 'T', assigneeId: 'mika' })
      fx.missions.markDispatched(task.id)
      const { text } = await callTool('mika', 'report_blocked', { reason: 'stuck' })
      expect(text).toBe('Marked "T" as blocked. A person will decide what happens next.')
      expect(messages.queuedFor('mira')).toEqual([])
    })

    it('still blocks the task if the manager cannot be told', async () => {
      const task = fx.missions.createTask({ missionId: mission.id, title: 'T', assigneeId: 'sora' })
      fx.missions.markDispatched(task.id)
      // Fill the manager's inbox so the notification is refused.
      for (let i = 0; i < 60; i++) {
        try {
          messages.sendFromAgent(
            'mika',
            { to: 'Mira', subject: `s${i}`, body: 'b' },
            { source: 'reported', employeeId: 'mika' },
          )
        } catch {
          break
        }
      }
      const { text, isError } = await callTool('sora', 'report_blocked', { reason: 'stuck' })
      expect(isError).toBe(false)
      expect(messages.queuedFor('mira', 200)).toHaveLength(MAX_QUEUED_PER_RECIPIENT)
      expect(text).toBe('Marked "T" as blocked. A person will decide what happens next.')
      expect(fx.missions.getTask(task.id)?.status).toBe('blocked')
    })
  })
})

describe("a manager's planning tools", () => {
  const squad = {
    list: () => [
      { id: 'mira', name: 'Mira', role: 'Manager', isManager: true, reportsTo: null },
      { id: 'sora', name: 'Sora', role: 'QA', isManager: false, reportsTo: 'mira' },
      { id: 'kai', name: 'Kai', role: 'Engineer', isManager: false, reportsTo: null },
    ],
    isRunning: () => true,
  }

  beforeEach(() => {
    fx.addEmployee('mira', 'Mira', 'Manager', { isManager: true })
    fx.addEmployee('sora', 'Sora', 'QA', { reportsTo: 'mira' })
    fx.addEmployee('kai', 'Kai', 'Engineer')
    messages = new MessageService({
      db: fx.services.db,
      events: fx.services.events,
      directory: squad,
      taskMissionId: (id) => fx.missions.getTask(id)?.missionId,
    })
    mcp = new McpEndpoint(
      { name: 'shokuba', version: 't' },
      createAgentTools(fx.missions, messages, squad),
    )
  })

  const toolsFor = async (employeeId: string): Promise<string[]> => {
    const reply = await mcp.handle(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { employeeId, source: 'reported' },
    )
    return (reply?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)
  }

  it('are offered to a manager and to no one else', async () => {
    expect(await toolsFor('mira')).toEqual([...AGENT_TOOL_NAMES, ...MANAGER_TOOL_NAMES])
    expect(await toolsFor('sora')).toEqual([...AGENT_TOOL_NAMES])
    expect(await toolsFor('kai')).toEqual([...AGENT_TOOL_NAMES])
  })

  it('cannot be called by someone who is not offered them, even by name', async () => {
    for (const name of MANAGER_TOOL_NAMES) {
      const reply = await mcp.handle(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } },
        { employeeId: 'sora', source: 'reported' },
      )
      expect(reply?.error?.message, name).toBe(`Unknown tool "${name}"`)
    }
    expect(fx.missions.listMissions().filter((d) => d.mission.title !== 'M')).toEqual([])
  })

  it('let a manager draft a plan, check it, and fix a mistake', async () => {
    const drafted = await callTool('mira', 'draft_mission', { title: 'Ship login' })
    expect(drafted.isError).toBe(false)
    expect(drafted.text).toContain('only a draft: nothing is sent until the person runs it')
    const missionId = /id (\S+)\)/.exec(drafted.text)?.[1] ?? ''

    const design = await callTool('mira', 'add_task', {
      missionId,
      title: 'Design the API',
      assignee: 'Sora',
    })
    expect(design.text).toMatch(/^Added "Design the API" \(id \S+\), assigned to Sora\.$/)
    const designId = /id (\S+)\)/.exec(design.text)?.[1] ?? ''
    const build = await callTool('mira', 'add_task', {
      missionId,
      title: 'Build it',
      dependsOn: ['Design the API'],
    })
    expect(build.text).toContain('not assigned to anyone yet, after "Design the API"')

    const shown = await callTool('mira', 'get_draft', { missionId })
    expect(shown.text).toContain('"Design the API"')
    expect(shown.text).toContain('after: Design the API')

    const removed = await callTool('mira', 'remove_task', { taskId: designId })
    expect(removed.isError).toBe(true) // "Build it" depends on it
    expect(removed.text).toContain('Other tasks depend on this one')
  })

  it('tell the model why a request is refused, in words it can act on', async () => {
    const { text } = await callTool('mira', 'draft_mission', { title: 'Plan' })
    const missionId = /id (\S+)\)/.exec(text)?.[1] ?? ''
    const outside = await callTool('mira', 'add_task', { missionId, title: 'X', assignee: 'Kai' })
    expect(outside.isError).toBe(true)
    expect(outside.text).toContain('"Kai" is not on your team. You can assign work to: Mira, Sora.')

    fx.missions.missionAction(missionId, 'run') // the person runs it
    const late = await callTool('mira', 'add_task', { missionId, title: 'Y' })
    expect(late.isError).toBe(true)
    expect(late.text).toContain('out of your hands')
  })

  it('show a manager how the team is doing', async () => {
    const { text } = await callTool('mira', 'team_status')
    expect(text).toBe('Your team:\n- Sora (QA) — running — no task in progress')
  })
})

describe('saving work when a task is submitted', () => {
  const seen: Array<{ id: string; status: string }> = []
  let fail = false

  beforeEach(() => {
    seen.length = 0
    fail = false
    mcp = new McpEndpoint(
      { name: 'shokuba', version: 't' },
      createAgentTools(fx.missions, messages, team, {
        beforeSubmit: (task) => {
          seen.push({ id: task.id, status: fx.missions.getTask(task.id)?.status ?? '?' })
          if (fail) throw new Error('git is broken')
        },
      }),
    )
  })

  it('happens before the task shows as submitted, so its work is already there', async () => {
    const task = handOut('Build it', 'mika')
    const { text, isError } = await callTool('mika', 'submit_task', { summary: 'Done.' })
    expect(isError).toBe(false)
    expect(text).toContain('Submitted "Build it"')
    expect(seen).toEqual([{ id: task.id, status: 'in_progress' }])
    expect(fx.missions.getTask(task.id)?.status).toBe('submitted')
  })

  it('never stops the submission if saving the work fails', async () => {
    fail = true
    const task = handOut('Build it', 'mika')
    const { isError } = await callTool('mika', 'submit_task', { summary: 'Done.' })
    expect(isError).toBe(false)
    expect(fx.missions.getTask(task.id)?.status).toBe('submitted')
  })

  it('is not asked to save anyone else’s work, and a refused submission is still refused', async () => {
    const theirs = handOut('Theirs', 'ren')
    const refused = await callTool('mika', 'submit_task', { taskId: theirs.id, summary: 'x' })
    expect(refused.isError).toBe(true)
    expect(seen).toEqual([])
    expect(fx.missions.getTask(theirs.id)?.status).toBe('in_progress')
  })

  it('has nothing to save for an agent with no task, and says so as before', async () => {
    const { isError, text } = await callTool('mika', 'submit_task', { summary: 'x' })
    expect(isError).toBe(true)
    expect(text).toMatch(/no task/i)
    expect(seen).toEqual([])
  })
})

describe("a reviewer's tools", () => {
  const reading = new Set<string>()
  const handedIn: Array<{ id: string; input: ReviewSubmit }> = []
  let refuse: ReviewError | null = null

  beforeEach(() => {
    reading.clear()
    handedIn.length = 0
    refuse = null
    mcp = new McpEndpoint(
      { name: 'shokuba', version: 't' },
      createAgentTools(fx.missions, messages, team, {
        reviews: {
          hasActive: (id) => reading.has(id),
          current: async (id) => (reading.has(id) ? '[Shokuba review]\nRead this.' : null),
          submit: (id, input) => {
            if (refuse) throw refuse
            handedIn.push({ id, input })
            return {
              verdict: input.verdict,
              findings: input.findings ?? [],
            } as unknown as Review
          },
        },
      }),
    )
  })

  const toolsFor = async (employeeId: string): Promise<string[]> => {
    const reply = await mcp.handle(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { employeeId, source: 'reported' },
    )
    return (reply?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)
  }

  it('are offered only while that employee is reading a review', async () => {
    expect(await toolsFor('mika')).toEqual([...AGENT_TOOL_NAMES])
    reading.add('mika')
    expect(await toolsFor('mika')).toEqual([...AGENT_TOOL_NAMES, ...REVIEW_TOOL_NAMES])
    expect(await toolsFor('ren')).toEqual([...AGENT_TOOL_NAMES])
    reading.delete('mika')
    expect(await toolsFor('mika')).toEqual([...AGENT_TOOL_NAMES])
  })

  it('cannot be called by anyone else, even by name', async () => {
    reading.add('mika')
    for (const name of REVIEW_TOOL_NAMES) {
      const reply = await mcp.handle(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } },
        { employeeId: 'ren', source: 'reported' },
      )
      expect(reply?.error?.message, name).toBe(`Unknown tool "${name}"`)
    }
    expect(handedIn).toEqual([])
  })

  it('show the reviewer their review again', async () => {
    reading.add('mika')
    const { text, isError } = await callTool('mika', 'get_current_review')
    expect(isError).toBe(false)
    expect(text).toBe('[Shokuba review]\nRead this.')
  })

  it('hand in a review as the caller', async () => {
    reading.add('mika')
    const { text, isError } = await callTool('mika', 'submit_review', {
      verdict: 'request_changes',
      summary: 'Does not validate the email.',
      findings: [{ severity: 'major', file: 'login.ts', line: 3, note: 'No validation.' }],
    })
    expect(isError).toBe(false)
    expect(text).toBe(
      'Review handed in: request changes, with 1 finding. A person will read it. You are done; do not change anything.',
    )
    expect(handedIn.map((h) => h.id)).toEqual(['mika'])
  })

  it('have no way to hand in a review as someone else', async () => {
    reading.add('mika')
    const { isError } = await callTool('mika', 'submit_review', {
      verdict: 'approve',
      summary: 'Fine.',
      reviewerId: 'ren',
    })
    expect(isError).toBe(true)
    expect(handedIn).toEqual([])
  })

  it('say "0 findings" for an approval with nothing to report', async () => {
    reading.add('mika')
    const { text } = await callTool('mika', 'submit_review', {
      verdict: 'approve',
      summary: 'Fine.',
    })
    expect(text).toContain('Review handed in: approve, with 0 findings.')
  })

  it('turn away something that is not a proper review before it reaches the service', async () => {
    reading.add('mika')
    const bad = await callTool('mika', 'submit_review', { verdict: 'lgtm', summary: 'ok' })
    expect(bad.isError).toBe(true)
    expect(handedIn).toEqual([])
  })

  it('tell the model why the service refused, in words it can act on', async () => {
    reading.add('mika')
    refuse = new ReviewError('no-review', 'You have no review in progress.')
    const { text, isError } = await callTool('mika', 'submit_review', {
      verdict: 'approve',
      summary: 'Fine.',
    })
    expect(isError).toBe(true)
    expect(text).toBe('You have no review in progress.')
  })

  it('are not offered at all when reviews are not switched on', async () => {
    mcp = new McpEndpoint(
      { name: 'shokuba', version: 't' },
      createAgentTools(fx.missions, messages, team),
    )
    expect(await toolsFor('mika')).toEqual([...AGENT_TOOL_NAMES])
  })
})
