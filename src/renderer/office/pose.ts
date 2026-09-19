import type { RuntimeState } from '@shared/types/agent'

/**
 * How an employee's body and desk look at a moment in time, given their runtime state.
 * Pure, so the animation rules are tested rather than eyeballed. Numbers are in grid units
 * (heights) or 0..1 (intensities).
 */
export interface Pose {
  /** Whether a person is sitting at the desk at all. */
  present: boolean
  headDz: number
  headDx: number
  /** Vertical offset of each forearm (typing moves them in alternation). */
  leftArmDz: number
  rightArmDz: number
  /** Extra height of the right arm, raised to get attention. */
  waveDz: number
  /** Status light on the monitor. */
  led: 'off' | 'sky' | 'green' | 'blue' | 'amber' | 'cyan' | 'red'
  ledOn: boolean
  /** 0..1 brightness of the light spilling onto the desk. */
  glow: number
}

const TAU = Math.PI * 2

function wave(t: number, hz: number, phase = 0): number {
  return Math.sin(t * TAU * hz + phase)
}

/** Pose for `state` at time `t` seconds. */
export function poseFor(state: RuntimeState, t: number): Pose {
  const base: Pose = {
    present: true,
    headDz: 0,
    headDx: 0,
    leftArmDz: 0,
    rightArmDz: 0,
    waveDz: 0,
    led: 'green',
    ledOn: true,
    glow: 0.25,
  }

  switch (state) {
    case 'offline':
    case 'stopped':
    case 'paused':
      return { ...base, present: false, led: 'off', ledOn: false, glow: 0 }

    case 'starting':
      return { ...base, led: 'amber', ledOn: wave(t, 2) > 0, glow: 0.15, headDz: 0.01 * wave(t, 1) }

    case 'idle':
      // Gentle breathing.
      return { ...base, led: 'sky', headDz: 0.012 * wave(t, 0.35), glow: 0.2 }

    case 'thinking':
      return {
        ...base,
        led: 'blue',
        ledOn: wave(t, 1.2) > -0.3,
        headDz: 0.03 * wave(t, 0.9),
        headDx: 0.02 * wave(t, 0.45),
        glow: 0.5,
      }

    case 'coding':
    case 'testing':
    case 'researching':
    case 'reviewing': {
      const hz = state === 'coding' ? 6 : 4
      return {
        ...base,
        led: state === 'coding' ? 'green' : state === 'testing' ? 'amber' : 'cyan',
        leftArmDz: 0.035 * Math.max(0, wave(t, hz)),
        rightArmDz: 0.035 * Math.max(0, wave(t, hz, Math.PI)),
        headDz: 0.008 * wave(t, hz / 2),
        glow: 0.8,
      }
    }

    case 'waiting':
    case 'blocked':
      return {
        ...base,
        led: 'amber',
        ledOn: wave(t, 1.6) > 0,
        waveDz: 0.45 + 0.1 * wave(t, 2.2),
        headDz: 0.02 * wave(t, 1.1),
        glow: 0.35,
      }

    case 'error':
      return {
        ...base,
        led: 'red',
        ledOn: wave(t, 3) > -0.2,
        headDz: -0.06,
        headDx: 0.02 * wave(t, 8),
        glow: 0.4,
      }
  }
}

export const LED_COLORS: Record<Pose['led'], number> = {
  off: 0x3a3632,
  sky: 0x8ab4e8,
  green: 0x6fdc8c,
  blue: 0x5aa2ff,
  amber: 0xffb547,
  cyan: 0x4fe0e0,
  red: 0xff5a4d,
}
