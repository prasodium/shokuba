import { describe, expect, it } from 'vitest'
import type { Department } from '@shared/departments'
import { createDepartmentsStore, type DepartmentsApi } from './departmentsStore'

const dept = (id: string, name = id): Department => ({
  id,
  name,
  color: '#5b8fc7',
  createdAt: 't',
  updatedAt: 't',
})

function fake(initial: Department[] = []) {
  let list = initial
  let counts: Record<string, number> = {}
  const calls: string[] = []
  const api: DepartmentsApi = {
    list: async () => {
      calls.push('list')
      return { departments: list, headcounts: counts }
    },
    create: async (input) => {
      calls.push('create')
      const made = dept(`d${list.length + 1}`, input.name)
      list = [...list, made]
      return made
    },
    update: async (id, patch) => {
      calls.push('update')
      const found = list.find((d) => d.id === id)
      if (!found) throw new Error("Error invoking remote method 'x': Error: No such department")
      const next = { ...found, ...patch }
      list = list.map((d) => (d.id === id ? next : d))
      return next
    },
    archive: async (id) => {
      calls.push('archive')
      list = list.filter((d) => d.id !== id)
    },
  }
  return { api, calls, setCounts: (next: Record<string, number>) => (counts = next) }
}

describe('the departments store', () => {
  it('reads the departments and how many people are in each', async () => {
    const { api, setCounts } = fake([dept('a'), dept('b')])
    setCounts({ a: 2 })
    const store = createDepartmentsStore(api)
    expect(store.getState().departments).toEqual([])
    await store.getState().refresh()
    expect(store.getState().departments.map((d) => d.id)).toEqual(['a', 'b'])
    expect(store.getState().headcounts).toEqual({ a: 2 })
  })

  it('reads again after each change, so the list is always what is stored', async () => {
    const { api, calls } = fake([dept('a')])
    const store = createDepartmentsStore(api)
    const made = await store.getState().create({ name: 'New' })
    expect(made).toMatchObject({ ok: true, value: { name: 'New' } })
    expect(store.getState().departments.map((d) => d.name)).toEqual(['a', 'New'])
    expect(calls).toEqual(['create', 'list'])
    await store.getState().archive('a')
    expect(store.getState().departments.map((d) => d.id)).toEqual(['d2'])
  })

  it('gives back the error as plain words, and does not read again, when a change is refused', async () => {
    const { api, calls } = fake([dept('a')])
    const store = createDepartmentsStore(api)
    const result = await store.getState().update('nope', { name: 'x' })
    expect(result).toEqual({ ok: false, error: 'No such department' })
    expect(calls).toEqual(['update'])
  })

  it('keeps what it has when a read fails', async () => {
    const api: DepartmentsApi = {
      ...fake().api,
      list: async () => {
        throw new Error('gone')
      },
    }
    const store = createDepartmentsStore(api)
    store.setState({ departments: [dept('kept')], headcounts: { kept: 1 } })
    await store.getState().refresh()
    expect(store.getState().departments.map((d) => d.id)).toEqual(['kept'])
    expect(store.getState().headcounts).toEqual({ kept: 1 })
  })

  it('folds reads asked for while one is under way into one more, so the last answer wins', async () => {
    let resolveFirst: (value: {
      departments: Department[]
      headcounts: Record<string, number>
    }) => void = () => {}
    let reads = 0
    const api: DepartmentsApi = {
      ...fake().api,
      list: () => {
        reads += 1
        return reads === 1
          ? new Promise((resolve) => (resolveFirst = resolve))
          : Promise.resolve({ departments: [dept('newer')], headcounts: {} })
      },
    }
    const store = createDepartmentsStore(api)
    const all = [store.getState().refresh(), store.getState().refresh(), store.getState().refresh()]
    resolveFirst({ departments: [dept('older')], headcounts: {} })
    await Promise.all(all)
    expect(reads).toBe(2)
    expect(store.getState().departments.map((d) => d.id)).toEqual(['newer'])
  })
})
