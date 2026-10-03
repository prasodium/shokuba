import type { ShokubaApi } from '@shared/ipc/api'

/**
 * Every call the window can make to the main process, as reading or acting. The table is checked by
 * the compiler: a call added to the API without being put here does not build, so nothing new can
 * slip past replay's read-only rule.
 */
export type Access = 'read' | 'act'
type AccessTable = { [N in keyof ShokubaApi]: { [M in keyof ShokubaApi[N]]: Access } }

export const ACCESS: AccessTable = {
  app: { info: 'read', git: 'read' },
  events: { list: 'read', subscribe: 'read' },
  providers: { list: 'read' },
  employees: { list: 'read', create: 'act', update: 'act', archive: 'act' },
  office: { get: 'read', save: 'act' },
  departments: { list: 'read', create: 'act', update: 'act', archive: 'act' },
  roles: {
    list: 'read',
    create: 'act',
    update: 'act',
    duplicate: 'act',
    archive: 'act',
    reset: 'act',
  },
  agents: { snapshot: 'read', start: 'act', stop: 'act', interrupt: 'act' },
  missions: {
    list: 'read',
    create: 'act',
    update: 'act',
    action: 'act',
    archive: 'act',
    branches: 'read',
  },
  tasks: { create: 'act', update: 'act', action: 'act', remove: 'act', changes: 'read' },
  checks: { get: 'read', save: 'act', suggest: 'read', forTask: 'read', run: 'act' },
  reviews: { forTask: 'read', request: 'act', saveSettings: 'act' },
  // Exporting writes a folder; it asks for a place to put it, so it is acting.
  evidence: { export: 'act' },
  github: {
    status: 'read',
    projects: 'read',
    issues: 'read',
    importIssue: 'act',
    links: 'read',
    askToPlan: 'act',
    takeBackPlan: 'act',
    // A preview writes nothing, but it is only ever the first step of opening a pull request.
    pullPreview: 'act',
    pullOpen: 'act',
    pullStatus: 'read',
    pullFollowUp: 'act',
  },
  messages: { list: 'read', send: 'act', markRead: 'act', action: 'act' },
  breaker: { action: 'act' },
  // Resizing reaches the agent's terminal, so it is acting too.
  terminal: { write: 'act', resize: 'act', replay: 'read', subscribe: 'read' },
  system: { pickDirectory: 'act' },
}

export const REPLAY_REFUSAL = 'Replay is read only. Go back to live to do this.'

export class ReplayReadOnlyError extends Error {
  constructor(readonly call: string) {
    super(REPLAY_REFUSAL)
    this.name = 'ReplayReadOnlyError'
  }
}

/**
 * The API, with every acting call refused while `replaying()` says so. The real API is looked up
 * at each call, so this can be made before the window has one (and in tests).
 */
export function guardApi(api: () => ShokubaApi, replaying: () => boolean): ShokubaApi {
  const guarded: Record<string, Record<string, unknown>> = {}
  for (const [namespace, methods] of Object.entries(ACCESS)) {
    const wrapped: Record<string, unknown> = {}
    for (const [method, access] of Object.entries(methods as Record<string, Access>)) {
      const call = (...args: unknown[]): unknown => {
        if (access === 'act' && replaying()) {
          return Promise.reject(new ReplayReadOnlyError(`${namespace}.${method}`))
        }
        const target = (
          api() as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>
        )[namespace]!
        return target[method]!(...args)
      }
      wrapped[method] = call
    }
    guarded[namespace] = wrapped
  }
  return guarded as unknown as ShokubaApi
}
