import { describe, expect, it } from 'vitest'
import { CapturePlanSchema } from './capture'

describe('a capture plan', () => {
  it('accepts the steps it has always had', () => {
    expect(() =>
      CapturePlanSchema.parse([
        { wait: 100 },
        { eval: '1 + 1' },
        { shot: '/tmp/a.png' },
        { type: 'hello' },
        { press: 'Enter' },
      ]),
    ).not.toThrow()
  })

  it('accepts a run of frames, with or without a region of the page', () => {
    expect(() =>
      CapturePlanSchema.parse([{ frames: { dir: '/tmp/f', count: 60, everyMs: 120 } }]),
    ).not.toThrow()
    expect(() =>
      CapturePlanSchema.parse([
        {
          frames: {
            dir: '/tmp/f',
            count: 60,
            everyMs: 120,
            crop: { x: 0, y: 0, width: 400, height: 300 },
          },
        },
      ]),
    ).not.toThrow()
  })

  it('refuses frames that are too many, too fast, or badly shaped', () => {
    const bad = [
      { frames: { dir: '/tmp/f', count: 0, everyMs: 120 } },
      { frames: { dir: '/tmp/f', count: 601, everyMs: 120 } },
      { frames: { dir: '/tmp/f', count: 10, everyMs: 5 } },
      { frames: { dir: '', count: 10, everyMs: 120 } },
      {
        frames: {
          dir: '/tmp/f',
          count: 10,
          everyMs: 120,
          crop: { x: 0, y: 0, width: 0, height: 3 },
        },
      },
      { frames: { dir: '/tmp/f', count: 10, everyMs: 120, extra: true } },
      { frames: 'lots' },
    ]
    for (const step of bad)
      expect(() => CapturePlanSchema.parse([step]), JSON.stringify(step)).toThrow()
  })
})
