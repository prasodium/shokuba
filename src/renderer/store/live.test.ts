import { describe, expect, it } from 'vitest'
import type { ShokubaEvent } from '@shared/events/schema'
import { emitLiveEvent, onLiveEvent } from './live'

const event = (seq: number): ShokubaEvent =>
  ({
    seq,
    id: `e${seq}`,
    ts: 't',
    source: 'system',
    type: 'agent.ready',
    payload: {},
  }) as ShokubaEvent

describe('live events', () => {
  it('tell every listener about each event, in order', () => {
    const a: number[] = []
    const b: number[] = []
    const stopA = onLiveEvent((e) => a.push(e.seq))
    const stopB = onLiveEvent((e) => b.push(e.seq))
    emitLiveEvent(event(1))
    emitLiveEvent(event(2))
    expect(a).toEqual([1, 2])
    expect(b).toEqual([1, 2])
    stopA()
    stopB()
  })

  it('tell nobody about what happened before they started listening', () => {
    emitLiveEvent(event(1))
    const heard: number[] = []
    const stop = onLiveEvent((e) => heard.push(e.seq))
    emitLiveEvent(event(2))
    expect(heard).toEqual([2])
    stop()
  })

  it('stop when a listener stops, and only that one', () => {
    const a: number[] = []
    const b: number[] = []
    const stopA = onLiveEvent((e) => a.push(e.seq))
    const stopB = onLiveEvent((e) => b.push(e.seq))
    stopA()
    emitLiveEvent(event(1))
    expect(a).toEqual([])
    expect(b).toEqual([1])
    stopA() // stopping twice is harmless
    stopB()
  })

  it('reach the others even when one listener fails', () => {
    const heard: number[] = []
    const stopBad = onLiveEvent(() => {
      throw new Error('cannot draw')
    })
    const stop = onLiveEvent((e) => heard.push(e.seq))
    expect(() => emitLiveEvent(event(1))).not.toThrow()
    expect(heard).toEqual([1])
    stopBad()
    stop()
  })

  it('do not tell a listener that starts listening in the middle of one about that same event', () => {
    const late: number[] = []
    let stopLate: (() => void) | undefined
    const stop = onLiveEvent(() => {
      stopLate ??= onLiveEvent((e) => late.push(e.seq))
    })
    emitLiveEvent(event(1))
    expect(late).toEqual([])
    emitLiveEvent(event(2))
    expect(late).toEqual([2])
    stop()
    stopLate?.()
  })

  it('let a listener stop itself while being told', () => {
    const heard: number[] = []
    const stop = onLiveEvent((e) => {
      heard.push(e.seq)
      stop()
    })
    emitLiveEvent(event(1))
    emitLiveEvent(event(2))
    expect(heard).toEqual([1])
  })
})
