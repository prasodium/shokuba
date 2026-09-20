import { describe, expect, it } from 'vitest'
import type { Role } from '@shared/roles'
import { createRolesStore, type RolesApi } from './rolesStore'

const role = (id: string, label = id): Role => ({
  id,
  label,
  isManager: false,
  instructions: '',
  permissionMode: 'default',
  builtin: false,
  createdAt: 't',
  updatedAt: 't',
})

/** An api over a list it keeps, and a log of what was asked. */
function fake(initial: Role[] = []) {
  let roles = initial
  const calls: string[] = []
  const api: RolesApi = {
    list: async () => {
      calls.push('list')
      return roles
    },
    create: async (input) => {
      calls.push('create')
      const made = role(`r${roles.length + 1}`, input.label)
      roles = [...roles, made]
      return made
    },
    update: async (id, patch) => {
      calls.push('update')
      const found = roles.find((r) => r.id === id)
      if (!found)
        throw new Error("Error invoking remote method 'shokuba:roles:update': Error: No such role")
      const next = { ...found, ...patch }
      roles = roles.map((r) => (r.id === id ? next : r))
      return next
    },
    duplicate: async (id) => {
      calls.push('duplicate')
      const made = role(`${id}-copy`)
      roles = [...roles, made]
      return made
    },
    archive: async (id) => {
      calls.push('archive')
      roles = roles.filter((r) => r.id !== id)
    },
    reset: async (id) => {
      calls.push('reset')
      return roles.find((r) => r.id === id) as Role
    },
  }
  return { api, calls, set: (next: Role[]) => (roles = next) }
}

describe('the roles store', () => {
  it('reads the roles from the main process', async () => {
    const { api } = fake([role('a'), role('b')])
    const store = createRolesStore(api)
    expect(store.getState().roles).toEqual([])
    await store.getState().refresh()
    expect(store.getState().roles.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('reads them again after each change, so the list is always what is stored', async () => {
    const { api, calls } = fake([role('a')])
    const store = createRolesStore(api)
    const made = await store.getState().create({ label: 'New' })
    expect(made).toMatchObject({ ok: true, value: { label: 'New' } })
    expect(store.getState().roles.map((r) => r.label)).toEqual(['a', 'New'])
    expect(calls).toEqual(['create', 'list'])

    await store.getState().archive('a')
    expect(store.getState().roles.map((r) => r.id)).toEqual(['r2'])
    await store.getState().duplicate('r2')
    expect(store.getState().roles).toHaveLength(2)
  })

  it('gives back the error as plain words, and does not read again, when a change is refused', async () => {
    const { api, calls } = fake([role('a')])
    const store = createRolesStore(api)
    await store.getState().refresh()
    const result = await store.getState().update('nope', { label: 'x' })
    expect(result).toEqual({ ok: false, error: 'No such role' })
    expect(calls).toEqual(['list', 'update'])
    expect(store.getState().roles.map((r) => r.id)).toEqual(['a'])
  })

  it('carries on with what it has when a read fails', async () => {
    const { api } = fake([role('a')])
    const store = createRolesStore(api)
    await store.getState().refresh()
    const failing: RolesApi = {
      ...api,
      list: async () => {
        throw new Error('gone')
      },
    }
    const broken = createRolesStore(failing)
    broken.setState({ roles: [role('kept')] })
    await broken.getState().refresh()
    expect(broken.getState().roles.map((r) => r.id)).toEqual(['kept'])
  })

  it('folds reads asked for while one is under way into one more, so the last answer wins', async () => {
    let resolveFirst: (roles: Role[]) => void = () => {}
    let reads = 0
    const api: RolesApi = {
      ...fake().api,
      list: () => {
        reads += 1
        return reads === 1
          ? new Promise<Role[]>((resolve) => (resolveFirst = resolve))
          : Promise.resolve([role('newer')])
      },
    }
    const store = createRolesStore(api)
    const first = store.getState().refresh()
    const second = store.getState().refresh()
    const third = store.getState().refresh()
    resolveFirst([role('older')])
    await Promise.all([first, second, third])
    expect(reads).toBe(2)
    expect(store.getState().roles.map((r) => r.id)).toEqual(['newer'])
  })

  it('resets a role and reads the list again', async () => {
    const { api, calls } = fake([role('a')])
    const store = createRolesStore(api)
    const result = await store.getState().reset('a')
    expect(result.ok).toBe(true)
    expect(calls).toEqual(['reset', 'list'])
  })
})
