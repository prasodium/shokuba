import { describe, expect, it } from 'vitest'
import { Scrollback } from './scrollback'

describe('Scrollback', () => {
  it('keeps everything while under the limit', () => {
    const s = new Scrollback(100)
    s.append('hello ')
    s.append('world')
    expect(s.read()).toBe('hello world')
  })

  it('drops the oldest output past the limit, staying bounded', () => {
    const s = new Scrollback(50)
    for (let i = 0; i < 200; i++) s.append(`line ${i}\n`)
    expect(s.read().length).toBeLessThanOrEqual(50)
    expect(s.read().endsWith('line 199\n')).toBe(true)
  })

  it('starts on a line boundary when it trims', () => {
    const s = new Scrollback(30)
    s.append('aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\ndddddddddd\n')
    expect(s.read().startsWith('cccccccccc') || s.read().startsWith('dddddddddd')).toBe(true)
  })

  it('handles a single chunk larger than the limit', () => {
    const s = new Scrollback(10)
    s.append('x'.repeat(1000))
    expect(s.read()).toBe('x'.repeat(10))
  })

  it('counts every character ever appended, even after old output is dropped', () => {
    const s = new Scrollback(10)
    s.append('a'.repeat(7))
    s.append('b'.repeat(30))
    expect(s.total).toBe(37)
    expect(s.read().length).toBeLessThanOrEqual(10)
  })
})
