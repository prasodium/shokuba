import { describe, expect, it } from 'vitest'
import type { TaskStatus } from '../missions'
import { hasControlCharacters } from '../missions'
import { dependentsOf, edgesOf, layerize, waitingOrReady, wouldCreateCycle } from './graph'

const t = (id: string, ...dependsOn: string[]) => ({ id, dependsOn })

describe('wouldCreateCycle', () => {
  const edges = edgesOf([t('a'), t('b', 'a'), t('c', 'b')])

  it('accepts dependencies that keep the graph acyclic', () => {
    expect(wouldCreateCycle('d', ['c'], edges)).toBe(false)
    expect(wouldCreateCycle('c', ['a'], edges)).toBe(false)
  })

  it('rejects a task depending on itself', () => {
    expect(wouldCreateCycle('a', ['a'], edges)).toBe(true)
  })

  it('rejects a direct cycle', () => {
    expect(wouldCreateCycle('a', ['b'], edges)).toBe(true)
  })

  it('rejects an indirect cycle through several tasks', () => {
    expect(wouldCreateCycle('a', ['c'], edges)).toBe(true)
  })

  it('does not loop on a graph that is already cyclic', () => {
    const cyclic = edgesOf([t('x', 'y'), t('y', 'x')])
    expect(wouldCreateCycle('z', ['x'], cyclic)).toBe(false)
  })

  it('handles dependencies on unknown ids', () => {
    expect(wouldCreateCycle('a', ['ghost'], edges)).toBe(false)
  })
})

describe('dependentsOf', () => {
  it('lists the tasks that depend directly on one', () => {
    const tasks = [t('a'), t('b', 'a'), t('c', 'a', 'b'), t('d')]
    expect(dependentsOf('a', tasks).sort()).toEqual(['b', 'c'])
    expect(dependentsOf('d', tasks)).toEqual([])
  })
})

describe('waitingOrReady', () => {
  const status = (map: Record<string, TaskStatus>) => (id: string) => map[id]

  it('is ready with no dependencies', () => {
    expect(waitingOrReady(t('a'), status({}))).toBe('ready')
  })

  it('is ready only when every dependency is done', () => {
    expect(waitingOrReady(t('c', 'a', 'b'), status({ a: 'done', b: 'done' }))).toBe('ready')
    expect(waitingOrReady(t('c', 'a', 'b'), status({ a: 'done', b: 'submitted' }))).toBe('pending')
  })

  it('treats a cancelled or unknown dependency as unsatisfied', () => {
    expect(waitingOrReady(t('b', 'a'), status({ a: 'cancelled' }))).toBe('pending')
    expect(waitingOrReady(t('b', 'ghost'), status({}))).toBe('pending')
  })
})

describe('layerize', () => {
  it('puts independent tasks in the first column', () => {
    const layers = layerize([t('a'), t('b')])
    expect([layers.get('a'), layers.get('b')]).toEqual([0, 0])
  })

  it('places a task one column after its furthest dependency', () => {
    const layers = layerize([t('a'), t('b', 'a'), t('c'), t('d', 'b', 'c')])
    expect(layers.get('a')).toBe(0)
    expect(layers.get('b')).toBe(1)
    expect(layers.get('c')).toBe(0)
    expect(layers.get('d')).toBe(2)
  })

  it('ignores dependencies on unknown tasks', () => {
    expect(layerize([t('a', 'ghost')]).get('a')).toBe(0)
  })

  it('terminates on a cyclic graph', () => {
    const layers = layerize([t('x', 'y'), t('y', 'x')])
    expect(layers.size).toBe(2)
  })
})

describe('hasControlCharacters', () => {
  const esc = String.fromCharCode(0x1b)
  const nul = String.fromCharCode(0)
  const del = String.fromCharCode(0x7f)

  it('flags escape, NUL and DEL characters', () => {
    expect(hasControlCharacters(`a${esc}[201~b`, true)).toBe(true)
    expect(hasControlCharacters(`a${nul}b`, true)).toBe(true)
    expect(hasControlCharacters(`a${del}b`, false)).toBe(true)
  })

  it('allows tabs and line breaks only where layout is allowed', () => {
    expect(hasControlCharacters('line one\nline two\tindented', true)).toBe(false)
    expect(hasControlCharacters('line one\nline two', false)).toBe(true)
  })

  it('accepts ordinary text, including non-ASCII', () => {
    expect(hasControlCharacters('職場 — plain text', false)).toBe(false)
  })
})
