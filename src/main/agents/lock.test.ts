import { describe, expect, it } from 'vitest'
import { AgentLock } from './lock'

describe('AgentLock', () => {
  it('gives an agent to one holder at a time', () => {
    const lock = new AgentLock()
    expect(lock.acquire('mika')).toBe(true)
    expect(lock.acquire('mika')).toBe(false)
    expect(lock.isHeld('mika')).toBe(true)
    lock.release('mika')
    expect(lock.isHeld('mika')).toBe(false)
    expect(lock.acquire('mika')).toBe(true)
  })

  it('holds each agent separately', () => {
    const lock = new AgentLock()
    expect(lock.acquire('mika')).toBe(true)
    expect(lock.acquire('ren')).toBe(true)
    lock.release('mika')
    expect(lock.isHeld('ren')).toBe(true)
  })

  it('does not mind being released when it was never held', () => {
    const lock = new AgentLock()
    expect(() => lock.release('nobody')).not.toThrow()
  })
})
