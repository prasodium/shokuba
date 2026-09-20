import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMissionFixture, type MissionFixture } from './fixtures'
import { MAX_OPEN_DRAFTS, MAX_TASKS_PER_DRAFT, ManagerPlanning } from './planning'
import { MissionError } from './service'

let fx: MissionFixture
let running: Set<string>
let plan: ManagerPlanning

beforeEach(() => {
  fx = createMissionFixture()
  running = new Set()
  fx.addEmployee('mira', 'Mira', 'Manager', { isManager: true })
  fx.addEmployee('kai', 'Kai', 'Manager', { isManager: true })
  fx.addEmployee('sora', 'Sora', 'QA', { reportsTo: 'mira' })
  fx.addEmployee('ren', 'Ren', 'Engineer', { reportsTo: 'mira' })
  fx.addEmployee('yui', 'Yui', 'Engineer', { reportsTo: 'kai' })
  fx.addEmployee('loner', 'Loner', 'Engineer')
  plan = new ManagerPlanning(fx.missions, {
    list: () => fx.directory(),
    isRunning: (id) => running.has(id),
  })
})

afterEach(() => fx.cleanup())

const draft = (title = 'Ship login', manager = 'mira') =>
  plan.draftMission(manager, { title }, 'reported')
const add = (missionId: string, title: string, extra: object = {}, manager = 'mira') =>
  plan.addTask(manager, { missionId, title, ...extra }, 'reported')

function refusal(work: () => unknown): MissionError {
  try {
    work()
  } catch (error) {
    expect(error).toBeInstanceOf(MissionError)
    return error as MissionError
  }
  throw new Error('expected a refusal')
}

describe('who may plan', () => {
  it('lets a manager draft', () => {
    expect(draft()).toMatchObject({ title: 'Ship login', status: 'draft', createdBy: 'mira' })
  })

  it('refuses everyone who is not a manager, however they ask', () => {
    for (const id of ['sora', 'loner', 'nobody']) {
      expect(refusal(() => plan.draftMission(id, { title: 'x' }, 'reported')).code).toBe(
        'forbidden',
      )
      expect(refusal(() => plan.teamStatus(id)).message).toMatch(/Only a manager/)
      expect(refusal(() => plan.describeDraft(id, undefined)).message).toMatch(/Only a manager/)
    }
  })
})

describe('a draft is only a draft', () => {
  it("is recorded as the manager's, and as reported by an agent, not by the person", () => {
    const mission = draft()
    const created = fx.eventsOf('mission.created')[0]
    expect(created).toMatchObject({ source: 'reported', actorId: 'mira' })
    expect(fx.missions.getMission(mission.id)?.createdBy).toBe('mira')
    // A mission the person makes has no author.
    expect(fx.missions.createMission({ title: 'Mine' }).createdBy).toBeNull()
    expect(fx.eventsOf('mission.created').at(-1)).toMatchObject({ source: 'user' })
  })

  it('never hands anything out: tasks stay waiting until a person runs the mission', () => {
    const mission = draft()
    add(mission.id, 'Test login', { assignee: 'Sora' })
    expect(fx.missions.dispatchCandidates()).toEqual([])
    fx.missions.missionAction(mission.id, 'run') // the person
    expect(fx.missions.dispatchCandidates().map((t) => t.title)).toEqual(['Test login'])
  })

  it('cannot be changed once the person has run it', () => {
    const mission = draft()
    const task = add(mission.id, 'Test login').task
    fx.missions.missionAction(mission.id, 'run')
    for (const attempt of [
      () => add(mission.id, 'Another'),
      () => plan.removeTask('mira', task.id, 'reported'),
    ]) {
      const error = refusal(attempt)
      expect(error.code).toBe('forbidden')
      expect(error.message).toContain('is running')
      expect(error.message).toContain('out of your hands')
    }
  })

  it('records who added and removed each task', () => {
    const mission = draft()
    const task = add(mission.id, 'Test login', { assignee: 'Sora' }).task
    plan.removeTask('mira', task.id, 'reported')
    for (const event of fx.eventsOf('task.created', 'task.assigned', 'task.updated')) {
      expect(event, event.type).toMatchObject({ source: 'reported', actorId: 'mira' })
    }
  })
})

describe('whose drafts a manager may touch', () => {
  it('only their own', () => {
    const others = draft("Kai's plan", 'kai')
    expect(refusal(() => add(others.id, 'Sneaky')).message).toMatch(
      /only work on missions you drafted/,
    )
    expect(refusal(() => plan.describeDraft('mira', others.id)).code).toBe('forbidden')
    const personal = fx.missions.createMission({ title: "The person's" })
    expect(refusal(() => add(personal.id, 'Sneaky')).code).toBe('forbidden')
    expect(fx.missions.listMissions().flatMap((d) => d.tasks)).toEqual([])
  })

  it("cannot remove a task from someone else's mission", () => {
    const others = draft("Kai's plan", 'kai')
    const task = add(others.id, 'Theirs', {}, 'kai').task
    expect(refusal(() => plan.removeTask('mira', task.id, 'reported')).code).toBe('forbidden')
    expect(fx.missions.getTask(task.id)).toBeDefined()
  })

  it('says plainly when the mission does not exist', () => {
    expect(refusal(() => add('nope', 'x')).code).toBe('not-found')
    expect(refusal(() => plan.removeTask('mira', 'nope', 'reported')).code).toBe('not-found')
  })
})

describe('who work may be assigned to', () => {
  it('the manager themself, or anyone who reports to them, by name or id', () => {
    const mission = draft()
    expect(add(mission.id, 'A', { assignee: 'Sora' }).assigneeName).toBe('Sora')
    expect(add(mission.id, 'B', { assignee: 'ren' }).assigneeName).toBe('Ren')
    expect(add(mission.id, 'C', { assignee: 'Mira' }).assigneeName).toBe('Mira')
    expect(add(mission.id, 'D').assigneeName).toBeNull()
  })

  it("nobody else: not another manager's people, not another manager, not someone with no manager", () => {
    const mission = draft()
    for (const who of ['Yui', 'Kai', 'Loner']) {
      const error = refusal(() => add(mission.id, 'X', { assignee: who }))
      expect(error.code).toBe('forbidden')
      expect(error.message).toContain('is not on your team')
      expect(error.message).toContain('Mira, Sora, Ren')
    }
    expect(fx.missions.listMissions()[0]?.tasks).toEqual([])
  })
})

describe('dependencies', () => {
  it('may be given by id or by exact title, and make the task wait', () => {
    const mission = draft()
    const design = add(mission.id, 'Design the API').task
    const build = add(mission.id, 'Build the API', { dependsOn: [design.id] })
    const test = add(mission.id, 'Test the API', { dependsOn: ['build the api'] })
    expect(build.waitsFor).toEqual(['Design the API'])
    expect(test.waitsFor).toEqual(['Build the API'])
    expect(fx.missions.getTask(build.task.id)?.status).toBe('pending')
    expect(fx.missions.getTask(design.id)?.status).toBe('ready')
  })

  it('refuses one that is not in this draft, or is ambiguous, with advice', () => {
    const mission = draft()
    add(mission.id, 'Same')
    add(mission.id, 'Same')
    expect(refusal(() => add(mission.id, 'X', { dependsOn: ['Ghost'] })).message).toMatch(
      /not a task in this draft/,
    )
    expect(refusal(() => add(mission.id, 'X', { dependsOn: ['Same'] })).message).toMatch(
      /More than one task/,
    )
    const other = draft('Other')
    const foreign = add(other.id, 'Elsewhere').task
    expect(refusal(() => add(mission.id, 'X', { dependsOn: [foreign.id] })).code).toBe('invalid')
  })
})

describe('limits', () => {
  it(`allows ${MAX_OPEN_DRAFTS} open drafts, and frees a slot once the person runs one`, () => {
    const first = draft('One')
    draft('Two')
    draft('Three')
    const error = refusal(() => draft('Four'))
    expect(error.code).toBe('forbidden')
    expect(error.message).toContain('3 drafts waiting')
    fx.missions.missionAction(first.id, 'run')
    expect(draft('Four').title).toBe('Four')
  })

  it("counts each manager's drafts separately", () => {
    for (const title of ['A', 'B', 'C']) draft(title)
    expect(draft("Kai's", 'kai').createdBy).toBe('kai')
  })

  it(`allows ${MAX_TASKS_PER_DRAFT} tasks in a draft`, () => {
    const mission = draft()
    for (let i = 0; i < MAX_TASKS_PER_DRAFT; i++) add(mission.id, `Task ${i}`)
    expect(refusal(() => add(mission.id, 'One too many')).message).toContain(
      `at most ${MAX_TASKS_PER_DRAFT}`,
    )
  })

  it('still validates what any mission validates (control characters, length)', () => {
    const escape = String.fromCharCode(27)
    expect(
      refusal(() => plan.draftMission('mira', { title: `a${escape}[2Jb` }, 'reported')).code,
    ).toBe('invalid')
    const mission = draft()
    expect(refusal(() => add(mission.id, 'x'.repeat(200))).code).toBe('invalid')
  })
})

describe('reading', () => {
  it('lists open drafts, then shows one with who does what and what waits', () => {
    expect(plan.describeDraft('mira', undefined)).toBe('You have no drafts waiting.')
    const mission = draft('Ship login')
    const design = add(mission.id, 'Design', { assignee: 'Sora' }).task
    add(mission.id, 'Build', { assignee: 'Ren', dependsOn: [design.id] })
    expect(plan.describeDraft('mira', undefined)).toContain(
      `"Ship login" — id ${mission.id} — 2 tasks`,
    )
    const text = plan.describeDraft('mira', mission.id)
    expect(text).toContain('draft (waiting for the person to run it)')
    expect(text).toContain('"Design" — id')
    expect(text).toContain('Sora')
    expect(text).toContain('after: Design')
  })

  it("shows a manager's own mission after it has run, but as information only", () => {
    const mission = draft()
    fx.missions.missionAction(mission.id, 'run')
    expect(plan.describeDraft('mira', mission.id)).toContain('running')
    expect(plan.describeDraft('mira', undefined)).toBe('You have no drafts waiting.')
  })

  it('shows the team: who is running and what they are on', () => {
    expect(plan.teamStatus('mira')).toBe(
      'Your team:\n- Sora (QA) — not running — no task in progress\n- Ren (Engineer) — not running — no task in progress',
    )
    running.add('sora')
    const mission = draft()
    const task = add(mission.id, 'Test login', { assignee: 'Sora' }).task
    fx.missions.missionAction(mission.id, 'run')
    fx.missions.markDispatched(task.id)
    expect(plan.teamStatus('mira')).toContain('Sora (QA) — running — working on "Test login"')
    expect(plan.teamStatus('mira')).not.toContain('Yui')
  })

  it('says so when nobody reports to the manager', () => {
    fx.addEmployee('lonely', 'Lonely', 'Manager', { isManager: true })
    expect(plan.teamStatus('lonely')).toBe('Nobody reports to you yet.')
  })
})

describe('a draft the person handed over to plan', () => {
  const handed = () => {
    const mission = fx.missions.createMission({ title: 'From an issue' })
    fx.missions.setPlanner(mission.id, 'mira')
    return mission
  }

  it('lets that manager add tasks, assign their team, and remove them, as for a draft of their own', () => {
    const mission = handed()
    add(mission.id, 'Write the fix', { assignee: 'Ren' })
    const second = add(mission.id, 'Test it', { assignee: 'Sora', dependsOn: ['Write the fix'] })
    const tasks = () =>
      fx.missions.listMissions().find((d) => d.mission.id === mission.id)?.tasks ?? []
    expect(tasks()).toHaveLength(2)
    plan.removeTask('mira', second.task.id, 'reported')
    expect(tasks().map((t) => t.title)).toEqual(['Write the fix'])
  })

  it('records what they did as reported by them, though the mission is the person’s', () => {
    const mission = handed()
    const { task } = add(mission.id, 'Write the fix')
    expect(fx.eventsOf('task.created').find((e) => e.taskId === task.id)).toMatchObject({
      source: 'reported',
      actorId: 'mira',
    })
    expect(fx.missions.getMission(mission.id)?.createdBy).toBeNull()
  })

  it('shows it among their drafts, and says it was handed to them', () => {
    const mission = handed()
    const own = draft('Their own')
    const list = plan.describeDraft('mira', undefined)
    expect(list).toContain(`id ${mission.id}`)
    expect(list).toContain('handed to you by the person to plan')
    expect(list).toContain(`id ${own.id}`)
    expect(list.split('\n').find((l) => l.includes(own.id))).not.toContain('handed to you')
    expect(plan.describeDraft('mira', mission.id)).toContain('From an issue')
  })

  it('does not count toward how many drafts they may start', () => {
    handed()
    for (let i = 0; i < MAX_OPEN_DRAFTS; i += 1) draft(`Own ${i}`)
    expect(refusal(() => draft('One too many')).message).toMatch(/already have/)
  })

  it('is still capped at the most tasks in a draft', () => {
    const mission = handed()
    for (let i = 0; i < MAX_TASKS_PER_DRAFT; i += 1) add(mission.id, `Task ${i}`)
    expect(refusal(() => add(mission.id, 'One too many')).message).toMatch(/at most/)
  })

  it('is only that manager’s: another manager, and anyone else, is refused', () => {
    const mission = handed()
    expect(refusal(() => add(mission.id, 'Sneak in', {}, 'kai')).code).toBe('forbidden')
    expect(refusal(() => add(mission.id, 'Sneak in', {}, 'sora')).code).toBe('forbidden')
    expect(refusal(() => plan.describeDraft('kai', mission.id)).message).toMatch(
      /handed to you to plan/,
    )
    expect(plan.describeDraft('kai', undefined)).toBe('You have no drafts waiting.')
  })

  it('is out of their hands the moment the person takes it back', () => {
    const mission = handed()
    const { task } = add(mission.id, 'Write the fix')
    fx.missions.setPlanner(mission.id, null)
    expect(refusal(() => add(mission.id, 'More')).code).toBe('forbidden')
    expect(refusal(() => plan.removeTask('mira', task.id, 'reported')).code).toBe('forbidden')
  })

  it('is out of their hands once the person runs it, like any draft', () => {
    const mission = handed()
    add(mission.id, 'Write the fix')
    fx.missions.missionAction(mission.id, 'run')
    expect(refusal(() => add(mission.id, 'More')).message).toMatch(/only a draft can be changed/)
  })

  it('does not let them run, pause, cancel or archive it: those are not tools they have', () => {
    const mission = handed()
    expect(fx.missions.getMission(mission.id)?.status).toBe('draft')
    expect(typeof (plan as unknown as Record<string, unknown>)['runMission']).toBe('undefined')
  })

  it('can be handed on to another manager, who then has it and the first does not', () => {
    const mission = handed()
    fx.missions.setPlanner(mission.id, 'kai')
    expect(refusal(() => add(mission.id, 'Old planner')).code).toBe('forbidden')
    expect(add(mission.id, 'New planner', {}, 'kai').task.title).toBe('New planner')
  })
})
