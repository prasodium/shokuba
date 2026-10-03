import { describe, expect, it } from 'vitest'
import type { ShokubaApi } from '@shared/ipc/api'
import { ACCESS, REPLAY_REFUSAL, ReplayReadOnlyError, guardApi, type Access } from './guard'

/** A stand-in API that records every call that reaches it. */
function fakeApi(): { api: ShokubaApi; reached: string[] } {
  const reached: string[] = []
  const api: Record<string, Record<string, unknown>> = {}
  for (const [namespace, methods] of Object.entries(ACCESS)) {
    api[namespace] = {}
    for (const method of Object.keys(methods)) {
      api[namespace][method] = (...args: unknown[]) => {
        reached.push(`${namespace}.${method}(${JSON.stringify(args)})`)
        return Promise.resolve(`${namespace}.${method}`)
      }
    }
  }
  return { api: api as unknown as ShokubaApi, reached }
}

const entries = (): [string, string, Access][] =>
  Object.entries(ACCESS).flatMap(([namespace, methods]) =>
    Object.entries(methods as Record<string, Access>).map(
      ([method, access]) => [namespace, method, access] as [string, string, Access],
    ),
  )

const callOf = (api: ShokubaApi, namespace: string, method: string) =>
  (api as unknown as Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>)[
    namespace
  ]![method]!

describe('the read-only guard', () => {
  it('lets every call through when live, with its arguments', async () => {
    const { api, reached } = fakeApi()
    const guarded = guardApi(
      () => api,
      () => false,
    )
    for (const [namespace, method] of entries()) {
      await expect(callOf(guarded, namespace, method)('x', 1)).resolves.toBe(
        `${namespace}.${method}`,
      )
    }
    expect(reached).toHaveLength(entries().length)
    expect(reached[0]).toBe('app.info(["x",1])')
  })

  it('refuses every acting call while replaying, before it leaves the window', async () => {
    const { api, reached } = fakeApi()
    const guarded = guardApi(
      () => api,
      () => true,
    )
    for (const [namespace, method, access] of entries()) {
      const result = callOf(guarded, namespace, method)()
      if (access === 'act') {
        await expect(result).rejects.toBeInstanceOf(ReplayReadOnlyError)
        await expect(callOf(guarded, namespace, method)()).rejects.toThrow(REPLAY_REFUSAL)
      } else {
        await expect(result).resolves.toBe(`${namespace}.${method}`)
      }
    }
    // Only reads reached the main process.
    const reads = entries().filter(([, , access]) => access === 'read')
    expect(reached.map((r) => r.split('(')[0])).toEqual(reads.map(([n, m]) => `${n}.${m}`))
  })

  it('reads the mode at each call, so leaving replay works at once', async () => {
    const { api } = fakeApi()
    let replaying = true
    const guarded = guardApi(
      () => api,
      () => replaying,
    )
    await expect(guarded.agents.start('a')).rejects.toBeInstanceOf(ReplayReadOnlyError)
    replaying = false
    await expect(guarded.agents.start('a')).resolves.toBe('agents.start')
  })

  it('names the refused call', async () => {
    const { api } = fakeApi()
    const error = await guardApi(
      () => api,
      () => true,
    )
      .terminal.write('a', 'rm -rf /')
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ call: 'terminal.write' })
  })

  it('counts as acting everything that changes something, sends something or asks for a place', () => {
    // Pinned, so a change to the table is a decision, not an accident.
    const acting = entries()
      .filter(([, , access]) => access === 'act')
      .map(([n, m]) => `${n}.${m}`)
    expect(acting).toEqual([
      'employees.create',
      'employees.update',
      'employees.archive',
      'office.save',
      'departments.create',
      'departments.update',
      'departments.archive',
      'roles.create',
      'roles.update',
      'roles.duplicate',
      'roles.archive',
      'roles.reset',
      'agents.start',
      'agents.stop',
      'agents.interrupt',
      'missions.create',
      'missions.update',
      'missions.action',
      'missions.archive',
      'tasks.create',
      'tasks.update',
      'tasks.action',
      'tasks.remove',
      'checks.save',
      'checks.run',
      'reviews.request',
      'reviews.saveSettings',
      'evidence.export',
      'github.importIssue',
      'github.askToPlan',
      'github.takeBackPlan',
      'github.pullPreview',
      'github.pullOpen',
      'github.pullFollowUp',
      'messages.send',
      'messages.markRead',
      'messages.action',
      'breaker.action',
      'terminal.write',
      'terminal.resize',
      'system.pickDirectory',
    ])
  })
})

describe('the only way out of the window', () => {
  it('is the guarded API: no other renderer file touches window.shokuba', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join, relative } = await import('node:path')
    const root = join(__dirname, '..')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
          if (readFileSync(path, 'utf8').includes('window.shokuba'))
            offenders.push(relative(root, path))
        }
      }
    }
    walk(root)
    expect(offenders.map((p) => p.split('\\').join('/'))).toEqual(['api.ts'])
  })
})
