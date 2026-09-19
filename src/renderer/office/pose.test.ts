import { describe, expect, it } from 'vitest'
import { RUNTIME_STATES } from '@shared/types/agent'
import { LED_COLORS, poseFor } from './pose'

describe('poseFor', () => {
  it('removes the person when the agent is not running', () => {
    for (const state of ['offline', 'stopped', 'paused'] as const) {
      const pose = poseFor(state, 1)
      expect(pose).toMatchObject({ present: false, ledOn: false, led: 'off' })
    }
  })

  it('has someone at the desk for every running state', () => {
    for (const state of RUNTIME_STATES) {
      if (state === 'offline' || state === 'stopped' || state === 'paused') continue
      expect(poseFor(state, 0).present).toBe(true)
    }
  })

  it('types with the hands in alternation while coding', () => {
    // At some time the left hand is up while the right is down, and vice versa.
    const samples = Array.from({ length: 60 }, (_, i) => poseFor('coding', i / 60))
    expect(samples.some((p) => p.leftArmDz > 0.02 && p.rightArmDz === 0)).toBe(true)
    expect(samples.some((p) => p.rightArmDz > 0.02 && p.leftArmDz === 0)).toBe(true)
  })

  it('keeps the hands still when idle', () => {
    for (let t = 0; t < 3; t += 0.25) {
      const pose = poseFor('idle', t)
      expect(pose.leftArmDz).toBe(0)
      expect(pose.rightArmDz).toBe(0)
    }
  })

  it('raises a hand and blinks amber when it needs a human', () => {
    const pose = poseFor('waiting', 0.1)
    expect(pose.waveDz).toBeGreaterThan(0.3)
    expect(pose.led).toBe('amber')
  })

  it('hangs its head and shows red on error', () => {
    const pose = poseFor('error', 0)
    expect(pose.headDz).toBeLessThan(0)
    expect(pose.led).toBe('red')
  })

  it('uses a distinct light for coding, testing and researching', () => {
    const leds = new Set(
      ['coding', 'testing', 'researching'].map((s) => poseFor(s as 'coding', 0).led),
    )
    expect(leds.size).toBe(3)
  })

  it('is deterministic', () => {
    expect(poseFor('thinking', 1.234)).toEqual(poseFor('thinking', 1.234))
  })

  it('defines a colour for every light', () => {
    for (const led of ['off', 'sky', 'green', 'blue', 'amber', 'cyan', 'red'] as const) {
      expect(typeof LED_COLORS[led]).toBe('number')
    }
  })
})
