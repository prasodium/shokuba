import { describe, expect, it } from 'vitest'
import { MAX_GAP_MS, MAX_PER_TICK, Replayer } from './replayer'

// Events recorded at 0s, 1s, 1.5s, then a ten-minute silence, then 10m 2s.
const TIMES = [0, 1_000, 1_500, 600_000, 602_000]

describe('the replay clock', () => {
  it('starts before the first event, paused, at 1x', () => {
    expect(new Replayer(TIMES).state).toEqual({ cursor: 0, playing: false, speed: 1 })
  })

  it('plays each event after the gap that was recorded before it', () => {
    const r = new Replayer(TIMES)
    r.play(0)
    expect(r.tick(0)).toEqual({ from: 0, to: 1 }) // the first event is due at once
    expect(r.tick(999)).toEqual({ from: 1, to: 1 })
    expect(r.tick(1_000)).toEqual({ from: 1, to: 2 })
    expect(r.tick(1_499)).toEqual({ from: 2, to: 2 })
    expect(r.tick(1_500)).toEqual({ from: 2, to: 3 })
  })

  it('plays a long silence as at most the longest gap', () => {
    const r = new Replayer(TIMES)
    r.seek(3)
    r.play(0)
    expect(r.waitBefore(3)).toBe(MAX_GAP_MS)
    expect(r.tick(MAX_GAP_MS - 1).to).toBe(3)
    expect(r.tick(MAX_GAP_MS).to).toBe(4)
  })

  it('goes 4x and 16x faster, and a change of speed takes effect at once', () => {
    const r = new Replayer(TIMES)
    r.seek(1)
    r.setSpeed(4, 0)
    r.play(0)
    expect(r.tick(249).to).toBe(1)
    expect(r.tick(250).to).toBe(2)
    r.setSpeed(16, 250)
    expect(r.waitBefore(2)).toBe(500 / 16)
    expect(r.tick(250 + 500 / 16).to).toBe(3)
  })

  it('catches up on everything due when a tick comes late, and stops at the end', () => {
    const r = new Replayer(TIMES)
    r.play(0)
    expect(r.tick(1_000_000)).toEqual({ from: 0, to: 5 })
    expect(r.state.playing).toBe(false)
    r.play(1_000_001)
    expect(r.state.playing).toBe(false) // nothing left to play
  })

  it('never moves past more than a tick’s worth of events at once', () => {
    const r = new Replayer(new Array<number>(MAX_PER_TICK * 2).fill(0))
    r.play(0)
    expect(r.tick(0).to).toBe(MAX_PER_TICK)
    expect(r.tick(0).to).toBe(MAX_PER_TICK * 2)
  })

  it('treats a clock that went backwards as no wait', () => {
    const r = new Replayer([5_000, 1_000, 2_000])
    expect(r.waitBefore(1)).toBe(0)
    expect(r.waitBefore(2)).toBe(1_000)
    expect(r.waitBefore(0)).toBe(0)
    expect(r.waitBefore(3)).toBe(0)
  })

  it('pauses', () => {
    const r = new Replayer(TIMES)
    r.play(0)
    r.pause()
    expect(r.tick(1_000_000)).toEqual({ from: 0, to: 0 })
  })

  it('steps one event at a time, paused, and never out of the log', () => {
    const r = new Replayer(TIMES)
    r.play(0)
    r.step(1)
    expect(r.state).toMatchObject({ cursor: 1, playing: false })
    r.step(-1)
    r.step(-1)
    expect(r.state.cursor).toBe(0)
    r.seek(5)
    r.step(1)
    expect(r.state.cursor).toBe(5)
  })

  it('seeks anywhere in the log, rounding, and keeps playing from there', () => {
    const r = new Replayer(TIMES)
    r.seek(-3)
    expect(r.state.cursor).toBe(0)
    r.seek(99)
    expect(r.state.cursor).toBe(5)
    r.seek(1.6)
    expect(r.state.cursor).toBe(2)
    r.play(0)
    r.seek(1, 10)
    expect(r.tick(1_009).to).toBe(1)
    expect(r.tick(1_010).to).toBe(2)
  })

  it('seeking to the end stops playing', () => {
    const r = new Replayer(TIMES)
    r.play(0)
    r.seek(5, 0)
    expect(r.state.playing).toBe(false)
  })

  it('stays inside a range', () => {
    const r = new Replayer(TIMES, 1, 3)
    expect(r.state.cursor).toBe(1)
    r.seek(0)
    expect(r.state.cursor).toBe(1)
    r.play(0)
    expect(r.tick(1_000_000)).toEqual({ from: 1, to: 3 })
    expect(r.state.playing).toBe(false)
    r.setRange(2, 99)
    expect(r.range).toEqual({ from: 2, to: 5 })
    expect(r.state.cursor).toBe(3)
    r.setRange(4, 2)
    expect(r.range).toEqual({ from: 4, to: 4 })
    expect(r.state.cursor).toBe(4)
  })
})
