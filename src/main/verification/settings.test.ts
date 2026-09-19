import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CheckSettingsSave } from '@shared/verification'
import { createMissionFixture, type MissionFixture } from '../missions/fixtures'
import { CheckError, CheckSettingsStore } from './settings'

let fx: MissionFixture
let store: CheckSettingsStore
let clock: number

beforeEach(() => {
  fx = createMissionFixture()
  clock = 0
  store = new CheckSettingsStore({
    db: fx.services.db,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++clock)),
  })
})

afterEach(() => fx.cleanup())

const REPO = '/work/my-project'
const save = (patch: Partial<CheckSettingsSave> = {}) =>
  store.save({
    repoRoot: REPO,
    acknowledged: true,
    steps: [
      { kind: 'setup', name: 'Install', command: 'npm ci' },
      { kind: 'check', name: 'Test', command: 'npm test' },
      { kind: 'check', name: 'Lint', command: 'npm run lint' },
    ],
    ...patch,
  })

function refusal(work: () => unknown): CheckError {
  try {
    work()
  } catch (error) {
    expect(error).toBeInstanceOf(CheckError)
    return error as CheckError
  }
  throw new Error('expected a refusal')
}

describe('a project with no checks', () => {
  it('has none, is not acknowledged, and runs nothing', () => {
    expect(store.get(REPO)).toEqual({ repoRoot: REPO, acknowledged: false, steps: [] })
    expect(store.isReady(REPO)).toBe(false)
    expect(store.stepsToRun(REPO)).toEqual([])
  })
})

describe('saving checks', () => {
  it('keeps the steps in the order given, with sensible defaults filled in', () => {
    const saved = save()
    expect(saved.steps.map((s) => s.name)).toEqual(['Install', 'Test', 'Lint'])
    expect(saved.steps[0]).toMatchObject({
      kind: 'setup',
      command: 'npm ci',
      timeoutSeconds: 600,
      enabled: true,
    })
    expect(new Set(saved.steps.map((s) => s.id)).size).toBe(3)
    expect(store.get(REPO)).toEqual(saved)
  })

  it('replaces what was there, rather than adding to it', () => {
    save()
    const again = save({ steps: [{ kind: 'check', name: 'Only', command: 'make test' }] })
    expect(again.steps.map((s) => s.name)).toEqual(['Only'])
  })

  it('keeps each project’s checks apart', () => {
    save()
    save({
      repoRoot: '/work/other',
      steps: [{ kind: 'check', name: 'Other', command: 'cargo test' }],
    })
    expect(store.get(REPO).steps).toHaveLength(3)
    expect(store.get('/work/other').steps.map((s) => s.name)).toEqual(['Other'])
  })

  it('refuses two steps with the same name, so a report is never ambiguous', () => {
    const error = refusal(() =>
      save({
        steps: [
          { kind: 'check', name: 'Test', command: 'a' },
          { kind: 'check', name: 'test', command: 'b' },
        ],
      }),
    )
    expect(error.message).toBe('Two steps are called "test"')
  })
})

describe('what a command may be', () => {
  it('refuses anything that is not one printable line', () => {
    const escape = String.fromCharCode(27)
    const nul = String.fromCharCode(0)
    for (const command of [
      'npm test\nrm -rf ~',
      'npm test\rx',
      `a${escape}[2Jb`,
      `a${nul}b`,
      '',
      '   ',
    ]) {
      const error = refusal(() => save({ steps: [{ kind: 'check', name: 'X', command }] }))
      expect(error.code, JSON.stringify(command)).toBe('invalid')
    }
  })

  it('has a length limit, and limits on how long it may run', () => {
    const one = (patch: object) => () =>
      save({ steps: [{ kind: 'check', name: 'X', command: 'x', ...patch }] })
    expect(refusal(one({ command: 'x'.repeat(1001) })).code).toBe('invalid')
    expect(refusal(one({ timeoutSeconds: 5 })).code).toBe('invalid')
    expect(refusal(one({ timeoutSeconds: 3601 })).code).toBe('invalid')
  })

  it('limits how many steps a project has', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      kind: 'check' as const,
      name: `Step ${i}`,
      command: 'x',
    }))
    expect(refusal(() => save({ steps: many })).code).toBe('invalid')
  })

  it('refuses fields it does not know, so nothing extra can be smuggled in', () => {
    const smuggled = { repoRoot: REPO, acknowledged: true, steps: [], extra: 1 }
    expect(refusal(() => store.save(smuggled as unknown as CheckSettingsSave)).code).toBe('invalid')
  })
})

describe('acknowledging that these run agent-written code', () => {
  it('is needed before anything runs, however the steps are set up', () => {
    save({ acknowledged: false })
    expect(store.get(REPO).acknowledged).toBe(false)
    expect(store.isReady(REPO)).toBe(false)
    expect(store.stepsToRun(REPO)).toEqual([])
  })

  it('makes the checks ready once given, and unready again if withdrawn', () => {
    save()
    expect(store.isReady(REPO)).toBe(true)
    save({ acknowledged: false })
    expect(store.isReady(REPO)).toBe(false)
  })

  it('is not enough on its own: there has to be a check to run, not only setup', () => {
    save({ steps: [{ kind: 'setup', name: 'Install', command: 'npm ci' }] })
    expect(store.isReady(REPO)).toBe(false)
    save({ steps: [{ kind: 'check', name: 'Test', command: 'npm test', enabled: false }] })
    expect(store.isReady(REPO)).toBe(false)
  })

  it('keeps the moment the person first agreed, however often they save again', () => {
    const at = (): string =>
      (
        fx.services.db.prepare('SELECT acknowledged_at FROM project_checks_settings').get() as {
          acknowledged_at: string
        }
      ).acknowledged_at
    save()
    const first = at()
    save()
    expect(at()).toBe(first)
  })
})

describe('the steps that run', () => {
  it('put setup first, then the checks, each in the order the person listed them, and skip disabled ones', () => {
    save({
      steps: [
        { kind: 'check', name: 'Test', command: 'npm test' },
        { kind: 'setup', name: 'Install', command: 'npm ci' },
        { kind: 'check', name: 'Skipped', command: 'no', enabled: false },
        { kind: 'check', name: 'Lint', command: 'npm run lint' },
      ],
    })
    expect(store.stepsToRun(REPO).map((s) => s.name)).toEqual(['Install', 'Test', 'Lint'])
  })
})
