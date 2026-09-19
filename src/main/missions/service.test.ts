import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Mission, Task } from '@shared/missions'
import { createMissionFixture, type MissionFixture } from './fixtures'
import { MissionError } from './service'

let fx: MissionFixture
let mission: Mission

beforeEach(() => {
  fx = createMissionFixture()
  fx.addEmployee('mika')
  fx.addEmployee('ren')
  mission = fx.missions.createMission({ title: 'Ship login', description: 'OAuth' })
})

afterEach(() => fx.cleanup())

const task = (
  title: string,
  extra: Partial<Parameters<typeof fx.missions.createTask>[0]> = {},
): Task => fx.missions.createTask({ missionId: mission.id, title, ...extra })

const statusOf = (id: string) => fx.missions.getTask(id)?.status

/** Run a mission's task all the way to `submitted` the way the dispatcher and an agent would. */
function submit(id: string, employeeId = 'mika'): void {
  fx.missions.markDispatched(id)
  fx.missions.agentSubmit(employeeId, { summary: 'did it' }, { source: 'reported' })
}

async function rejection(work: () => unknown): Promise<MissionError> {
  try {
    work()
  } catch (error) {
    expect(error).toBeInstanceOf(MissionError)
    return error as MissionError
  }
  throw new Error('expected a MissionError')
}

describe('missions', () => {
  it('starts as a draft and announces itself', () => {
    expect(mission).toMatchObject({ title: 'Ship login', status: 'draft', priority: 'normal' })
    expect(fx.eventsOf('mission.created')[0]).toMatchObject({
      source: 'user',
      missionId: mission.id,
      payload: { missionId: mission.id, title: 'Ship login' },
    })
  })

  it('rejects an empty or multi-line title and control characters', () => {
    expect(() => fx.missions.createMission({ title: '' })).toThrow(MissionError)
    expect(() => fx.missions.createMission({ title: 'two\nlines' })).toThrow(MissionError)
    expect(() =>
      fx.missions.createMission({ title: 'a', description: `x${String.fromCharCode(27)}y` }),
    ).toThrow(MissionError)
  })

  it('runs, pauses and resumes, recording each change', () => {
    expect(fx.missions.missionAction(mission.id, 'run').status).toBe('running')
    expect(fx.missions.missionAction(mission.id, 'pause').status).toBe('paused')
    expect(fx.missions.missionAction(mission.id, 'run').status).toBe('running')
    const changes = fx
      .eventsOf('mission.status.changed')
      .map((e) => (e.type === 'mission.status.changed' ? `${e.payload.from}>${e.payload.to}` : ''))
    expect(changes).toEqual(['draft>running', 'running>paused', 'paused>running'])
  })

  it('refuses impossible transitions', async () => {
    expect((await rejection(() => fx.missions.missionAction(mission.id, 'pause'))).code).toBe(
      'state',
    )
    fx.missions.missionAction(mission.id, 'cancel')
    expect((await rejection(() => fx.missions.missionAction(mission.id, 'run'))).code).toBe('state')
  })

  it('cancelling closes every open task', () => {
    const a = task('A')
    const b = task('B', { dependsOn: [a.id] })
    fx.missions.missionAction(mission.id, 'cancel')
    expect([statusOf(a.id), statusOf(b.id)]).toEqual(['cancelled', 'cancelled'])
  })

  it('can be edited until it is closed', async () => {
    expect(fx.missions.updateMission(mission.id, { title: 'Ship login v2' }).title).toBe(
      'Ship login v2',
    )
    fx.missions.missionAction(mission.id, 'cancel')
    expect(
      (await rejection(() => fx.missions.updateMission(mission.id, { title: 'x' }))).code,
    ).toBe('closed')
  })

  it('cannot be archived while running or while an agent works', async () => {
    const a = task('A', { assigneeId: 'mika' })
    fx.missions.missionAction(mission.id, 'run')
    expect((await rejection(() => fx.missions.archiveMission(mission.id))).code).toBe('state')
    fx.missions.markDispatched(a.id)
    fx.missions.missionAction(mission.id, 'pause')
    expect((await rejection(() => fx.missions.archiveMission(mission.id))).code).toBe('state')
    fx.missions.agentSubmit('mika', { summary: 's' }, { source: 'reported' })
    fx.missions.archiveMission(mission.id)
    expect(fx.missions.listMissions()).toEqual([])
  })
})

describe('creating tasks', () => {
  it('is ready with no dependencies, pending with an unfinished one', () => {
    const a = task('A')
    const b = task('B', { dependsOn: [a.id] })
    expect([a.status, b.status]).toEqual(['ready', 'pending'])
    expect(b.dependsOn).toEqual([a.id])
  })

  it('keeps the order tasks were added in', () => {
    const [a, b, c] = [task('A'), task('B'), task('C')]
    expect(fx.missions.listMissions()[0]?.tasks.map((t) => t.id)).toEqual([a.id, b.id, c.id])
  })

  it('announces the task and its assignee', () => {
    const a = task('A', { assigneeId: 'mika' })
    expect(fx.eventsOf('task.created')[0]?.payload).toMatchObject({ taskId: a.id, title: 'A' })
    expect(fx.eventsOf('task.assigned')[0]?.payload).toMatchObject({
      taskId: a.id,
      employeeId: 'mika',
    })
  })

  it('rejects an unknown assignee, and dependencies outside the mission', async () => {
    expect((await rejection(() => task('A', { assigneeId: 'ghost' }))).code).toBe(
      'unknown-employee',
    )
    const other = fx.missions.createMission({ title: 'Other' })
    const foreign = fx.missions.createTask({ missionId: other.id, title: 'F' })
    expect((await rejection(() => task('A', { dependsOn: [foreign.id] }))).code).toBe('invalid')
    expect((await rejection(() => task('A', { dependsOn: ['ghost'] }))).code).toBe('invalid')
  })

  it('refuses to add work to a closed mission', async () => {
    fx.missions.missionAction(mission.id, 'cancel')
    expect((await rejection(() => task('A'))).code).toBe('closed')
  })
})

describe('editing tasks', () => {
  it('changes only what is given', () => {
    const a = task('A', { description: 'first' })
    const updated = fx.missions.updateTask(a.id, {
      title: 'A2',
      priority: 'high',
      assigneeId: 'ren',
    })
    expect(updated).toMatchObject({
      title: 'A2',
      description: 'first',
      priority: 'high',
      assigneeId: 'ren',
    })
    const event = fx.eventsOf('task.updated').at(-1)
    const fields = event?.type === 'task.updated' ? [...event.payload.fields].sort() : []
    expect(fields).toEqual(['assigneeId', 'priority', 'title'])
  })

  it('moves a task between waiting and ready as its dependencies change', () => {
    const a = task('A')
    const b = task('B')
    expect(statusOf(b.id)).toBe('ready')
    fx.missions.updateTask(b.id, { dependsOn: [a.id] })
    expect(statusOf(b.id)).toBe('pending')
    fx.missions.updateTask(b.id, { dependsOn: [] })
    expect(statusOf(b.id)).toBe('ready')
  })

  it('rejects dependency cycles of any length', async () => {
    const a = task('A')
    const b = task('B', { dependsOn: [a.id] })
    const c = task('C', { dependsOn: [b.id] })
    expect((await rejection(() => fx.missions.updateTask(a.id, { dependsOn: [a.id] }))).code).toBe(
      'cycle',
    )
    expect((await rejection(() => fx.missions.updateTask(a.id, { dependsOn: [b.id] }))).code).toBe(
      'cycle',
    )
    expect((await rejection(() => fx.missions.updateTask(a.id, { dependsOn: [c.id] }))).code).toBe(
      'cycle',
    )
    expect(fx.missions.getTask(a.id)?.dependsOn).toEqual([])
  })

  it('refuses to edit a task an agent is working on or has submitted', async () => {
    const a = task('A', { assigneeId: 'mika' })
    fx.missions.missionAction(mission.id, 'run')
    fx.missions.markDispatched(a.id)
    expect((await rejection(() => fx.missions.updateTask(a.id, { title: 'x' }))).code).toBe('state')
    fx.missions.agentSubmit('mika', { summary: 's' }, { source: 'reported' })
    expect((await rejection(() => fx.missions.updateTask(a.id, { title: 'x' }))).code).toBe('state')
  })

  it('is all-or-nothing: a failed edit changes and announces nothing', async () => {
    const a = task('A')
    const before = fx.eventsOf().length
    await rejection(() => fx.missions.updateTask(a.id, { title: 'new', dependsOn: [a.id] }))
    expect(fx.missions.getTask(a.id)?.title).toBe('A')
    expect(fx.eventsOf()).toHaveLength(before)
  })
})

describe('reviewing work', () => {
  beforeEach(() => fx.missions.missionAction(mission.id, 'run'))

  it('an agent submitting is a claim: submitted, never done', () => {
    const a = task('A', { assigneeId: 'mika' })
    submit(a.id)
    expect(statusOf(a.id)).toBe('submitted')
    expect(fx.missions.getTask(a.id)?.summary).toBe('did it')
  })

  it('only a person accepting makes it done, and that unblocks dependents', () => {
    const a = task('A', { assigneeId: 'mika' })
    const b = task('B', { dependsOn: [a.id] })
    submit(a.id)
    expect(statusOf(b.id)).toBe('pending')
    fx.missions.taskAction(a.id, { action: 'accept' })
    expect(statusOf(a.id)).toBe('done')
    expect(statusOf(b.id)).toBe('ready')
    expect(fx.missions.getTask(a.id)?.completedAt).not.toBeNull()
  })

  it('cannot accept work that was not submitted', async () => {
    const a = task('A', { assigneeId: 'mika' })
    expect((await rejection(() => fx.missions.taskAction(a.id, { action: 'accept' }))).code).toBe(
      'state',
    )
  })

  it('sends work back with a note, and the note reaches the next briefing', () => {
    const a = task('A', { assigneeId: 'mika' })
    submit(a.id)
    fx.missions.taskAction(a.id, { action: 'request-changes', note: 'Add a test' })
    expect(statusOf(a.id)).toBe('changes_requested')
    fx.missions.markDispatched(a.id)
    expect(fx.missions.getTask(a.id)?.attempts).toBe(2)
    expect(fx.missions.briefing(a.id)).toContain('Add a test')
    expect(fx.missions.briefing(a.id)).toContain('Attempt: 2')
  })

  it('finishes the mission once every task is closed', () => {
    const a = task('A', { assigneeId: 'mika' })
    const b = task('B', { assigneeId: 'ren' })
    submit(a.id)
    fx.missions.taskAction(a.id, { action: 'accept' })
    expect(fx.missions.getMission(mission.id)?.status).toBe('running')
    fx.missions.taskAction(b.id, { action: 'cancel' })
    expect(fx.missions.getMission(mission.id)?.status).toBe('completed')
  })

  it('does not complete a mission whose every task was cancelled', () => {
    const a = task('A')
    fx.missions.taskAction(a.id, { action: 'cancel' })
    expect(fx.missions.getMission(mission.id)?.status).toBe('running')
  })

  it('leaves dependents waiting when their dependency is cancelled', () => {
    const a = task('A')
    const b = task('B', { dependsOn: [a.id] })
    fx.missions.taskAction(a.id, { action: 'cancel' })
    expect(statusOf(b.id)).toBe('pending')
  })

  it('a blocked task can be retried', () => {
    const a = task('A', { assigneeId: 'mika' })
    fx.missions.markDispatched(a.id)
    fx.missions.agentBlocked('mika', { reason: 'no access' }, { source: 'reported' })
    expect(fx.missions.getTask(a.id)).toMatchObject({
      status: 'blocked',
      blockedReason: 'no access',
    })
    fx.missions.taskAction(a.id, { action: 'retry' })
    expect(fx.missions.getTask(a.id)).toMatchObject({ status: 'ready', blockedReason: null })
  })
})

describe('removing tasks', () => {
  it('removes one that never started and that nothing depends on', () => {
    const a = task('A')
    fx.missions.removeTask(a.id)
    expect(fx.missions.getTask(a.id)).toBeUndefined()
  })

  it('refuses when other tasks depend on it, or when it has run', async () => {
    const a = task('A', { assigneeId: 'mika' })
    task('B', { dependsOn: [a.id] })
    expect((await rejection(() => fx.missions.removeTask(a.id))).code).toBe('state')
    const c = task('C', { assigneeId: 'ren' })
    fx.missions.missionAction(mission.id, 'run')
    fx.missions.markDispatched(c.id)
    expect((await rejection(() => fx.missions.removeTask(c.id))).code).toBe('state')
  })
})

describe('dispatching', () => {
  it('offers only ready or sent-back tasks that are assigned, in running missions', () => {
    const assigned = task('assigned', { assigneeId: 'mika' })
    task('unassigned')
    task('waiting', { assigneeId: 'ren', dependsOn: [assigned.id] })
    expect(fx.missions.dispatchCandidates()).toEqual([]) // mission is still a draft
    fx.missions.missionAction(mission.id, 'run')
    expect(fx.missions.dispatchCandidates().map((t) => t.id)).toEqual([assigned.id])
    fx.missions.missionAction(mission.id, 'pause')
    expect(fx.missions.dispatchCandidates()).toEqual([])
  })

  it('orders by priority, then position', () => {
    const low = task('low', { assigneeId: 'mika', priority: 'low' })
    const high = task('high', { assigneeId: 'ren', priority: 'high' })
    const normal = task('normal', { assigneeId: 'mika' })
    fx.missions.missionAction(mission.id, 'run')
    expect(fx.missions.dispatchCandidates().map((t) => t.id)).toEqual([high.id, normal.id, low.id])
  })

  it('claims a task atomically: a second claim fails', async () => {
    const a = task('A', { assigneeId: 'mika' })
    fx.missions.missionAction(mission.id, 'run')
    const claimed = fx.missions.markDispatched(a.id)
    expect(claimed).toMatchObject({ status: 'in_progress', attempts: 1 })
    expect(claimed.startedAt).not.toBeNull()
    expect((await rejection(() => fx.missions.markDispatched(a.id))).code).toBe('state')
    expect(fx.missions.hasActiveTask('mika')).toBe(true)
    expect(fx.missions.hasActiveTask('ren')).toBe(false)
  })

  it('will not claim a task in a mission that is not running', async () => {
    const a = task('A', { assigneeId: 'mika' })
    expect((await rejection(() => fx.missions.markDispatched(a.id))).code).toBe('state')
  })

  it('puts a task back if it could not be delivered', () => {
    const a = task('A', { assigneeId: 'mika' })
    fx.missions.missionAction(mission.id, 'run')
    fx.missions.markDispatched(a.id)
    fx.missions.revertDispatch(a.id, 'could not reach the agent')
    expect(fx.missions.getTask(a.id)).toMatchObject({ status: 'ready', attempts: 0 })
  })

  it('a sent-back task returns to changes_requested, keeping its feedback', () => {
    const a = task('A', { assigneeId: 'mika' })
    fx.missions.missionAction(mission.id, 'run')
    submit(a.id)
    fx.missions.taskAction(a.id, { action: 'request-changes', note: 'fix' })
    fx.missions.markDispatched(a.id)
    fx.missions.revertDispatch(a.id, 'x')
    expect(statusOf(a.id)).toBe('changes_requested')
    expect(fx.missions.getTask(a.id)?.reviewNote).toBe('fix')
  })

  it('briefs the agent with the mission, the task and what teammates finished', () => {
    const a = task('Design the API', { assigneeId: 'mika' })
    const b = task('Build the API', {
      description: 'Follow the design',
      assigneeId: 'ren',
      dependsOn: [a.id],
    })
    fx.missions.missionAction(mission.id, 'run')
    submit(a.id)
    fx.missions.taskAction(a.id, { action: 'accept' })
    fx.missions.markDispatched(b.id)
    const text = fx.missions.briefing(b.id)
    expect(text).toContain('[Shokuba task]')
    expect(text).toContain('Mission: Ship login')
    expect(text).toContain(`Task id: ${b.id}`)
    expect(text).toContain('Follow the design')
    expect(text).toContain('Design the API: did it')
    expect(text).toContain('submit_task')
  })

  it('records who handed a task out as the system, not the user', () => {
    const a = task('A', { assigneeId: 'mika' })
    fx.missions.missionAction(mission.id, 'run')
    fx.missions.markDispatched(a.id)
    const change = fx.eventsOf('task.status.changed').at(-1)
    expect(change).toMatchObject({ source: 'system', taskId: a.id })
  })
})

describe('what an agent may do', () => {
  beforeEach(() => fx.missions.missionAction(mission.id, 'run'))

  it('sees only its own current task', () => {
    const a = task('A', { assigneeId: 'mika' })
    fx.missions.markDispatched(a.id)
    expect(fx.missions.currentTaskFor('mika')?.id).toBe(a.id)
    expect(fx.missions.currentTaskFor('ren')).toBeUndefined()
  })

  it('cannot submit with nothing in progress', async () => {
    expect(
      (
        await rejection(() =>
          fx.missions.agentSubmit('mika', { summary: 's' }, { source: 'reported' }),
        )
      ).code,
    ).toBe('state')
  })

  it("cannot submit or block someone else's task", async () => {
    const a = task('A', { assigneeId: 'mika' })
    fx.missions.markDispatched(a.id)
    const stolen = { taskId: a.id, summary: 'mine now' }
    expect(
      (await rejection(() => fx.missions.agentSubmit('ren', stolen, { source: 'reported' }))).code,
    ).toBe('forbidden')
    expect(
      (
        await rejection(() =>
          fx.missions.agentBlocked('ren', { taskId: a.id, reason: 'x' }, { source: 'reported' }),
        )
      ).code,
    ).toBe('forbidden')
    expect(statusOf(a.id)).toBe('in_progress')
  })

  it('cannot submit a task that is not in progress, or one that does not exist', async () => {
    const a = task('A', { assigneeId: 'mika' })
    expect(
      (
        await rejection(() =>
          fx.missions.agentSubmit('mika', { taskId: a.id, summary: 's' }, { source: 'reported' }),
        )
      ).code,
    ).toBe('state')
    expect(
      (
        await rejection(() =>
          fx.missions.agentSubmit(
            'mika',
            { taskId: 'ghost', summary: 's' },
            { source: 'reported' },
          ),
        )
      ).code,
    ).toBe('not-found')
  })

  it('cannot submit twice', async () => {
    const a = task('A', { assigneeId: 'mika' })
    submit(a.id)
    expect(
      (
        await rejection(() =>
          fx.missions.agentSubmit('mika', { summary: 'again' }, { source: 'reported' }),
        )
      ).code,
    ).toBe('state')
  })

  it('needs a real summary, cleaned of control characters and bounded', async () => {
    const a = task('A', { assigneeId: 'mika' })
    fx.missions.markDispatched(a.id)
    expect(
      (
        await rejection(() =>
          fx.missions.agentSubmit('mika', { summary: '   ' }, { source: 'reported' }),
        )
      ).code,
    ).toBe('invalid')
    const dirty = `ok${String.fromCharCode(27)}[2Jdone${'x'.repeat(9000)}`
    fx.missions.agentSubmit('mika', { summary: dirty }, { source: 'reported' })
    const summary = fx.missions.getTask(a.id)?.summary ?? ''
    expect(summary).not.toContain(String.fromCharCode(27))
    expect(summary.length).toBeLessThanOrEqual(4000)
  })

  it('labels agent-made changes with how we know (reported or simulated) and who did it', () => {
    const a = task('A', { assigneeId: 'mika' })
    fx.missions.markDispatched(a.id)
    fx.missions.agentSubmit('mika', { summary: 's' }, { source: 'simulated' })
    expect(fx.eventsOf('task.status.changed').at(-1)).toMatchObject({
      source: 'simulated',
      actorId: 'mika',
    })
  })
})

describe('recovery', () => {
  beforeEach(() => fx.missions.missionAction(mission.id, 'run'))

  it('blocks what an agent was doing when its process ends', () => {
    const a = task('A', { assigneeId: 'mika' })
    fx.missions.markDispatched(a.id)
    fx.missions.blockAgentTasks('mika', 'the agent stopped')
    expect(fx.missions.getTask(a.id)).toMatchObject({
      status: 'blocked',
      blockedReason: 'the agent stopped',
    })
  })

  it("leaves other agents' and finished tasks alone", () => {
    const a = task('A', { assigneeId: 'mika' })
    const b = task('B', { assigneeId: 'ren' })
    fx.missions.markDispatched(b.id)
    fx.missions.blockAgentTasks('mika', 'x')
    expect(statusOf(a.id)).toBe('ready')
    expect(statusOf(b.id)).toBe('in_progress')
  })

  it('blocks everything still in progress after a restart', () => {
    const a = task('A', { assigneeId: 'mika' })
    const b = task('B', { assigneeId: 'ren' })
    fx.missions.markDispatched(a.id)
    fx.missions.markDispatched(b.id)
    expect(fx.missions.blockAllInProgress('Shokuba restarted')).toBe(2)
    expect([statusOf(a.id), statusOf(b.id)]).toEqual(['blocked', 'blocked'])
    expect(fx.missions.blockAllInProgress('again')).toBe(0)
  })
})
