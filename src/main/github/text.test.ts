import { describe, expect, it } from 'vitest'
import { cleanLine, cleanText } from './text'

const chr = (...codes: number[]) => String.fromCharCode(...codes)

describe('cleanText', () => {
  it('leaves ordinary text, including line breaks, tabs and any language, as it is', () => {
    const text = 'Fix the login form\n\n\t- step one\n- step two\nÜñíçødé 日本語 😀'
    expect(cleanText(text, 500)).toBe(text)
  })

  it('makes every kind of line ending a newline', () => {
    expect(cleanText('a\r\nb\rc\nd', 100)).toBe('a\nb\nc\nd')
  })

  it('takes out control characters, keeping the newline and the tab', () => {
    expect(cleanText(`a${chr(0)}b${chr(7)}c${chr(0x1b)}[31md${chr(0x7f)}e${chr(0x85)}f`, 100)).toBe(
      'abc[31mdef',
    )
    expect(cleanText('a\tb\nc', 100)).toBe('a\tb\nc')
  })

  it('takes out the characters that reverse or hide text, which could disguise what it says', () => {
    const bidi = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]
    for (const code of bidi) expect(cleanText(`a${chr(code)}b`, 100), code.toString(16)).toBe('ab')
    for (const code of [0x200b, 0x2060, 0xfeff, 0xad]) {
      expect(cleanText(`a${chr(code)}b`, 100), code.toString(16)).toBe('ab')
    }
    // A zero-width joiner is part of some emoji, so it stays.
    expect(cleanText('👨\u200d💻', 100)).toBe('👨\u200d💻')
  })

  it('cuts to the length with an ellipsis, by character, so an emoji is never split', () => {
    expect(cleanText('abcdef', 4)).toBe('abc…')
    expect(cleanText('abcd', 4)).toBe('abcd')
    expect(cleanText('😀😀😀😀😀', 3)).toBe('😀😀…')
    expect([...cleanText('x'.repeat(50_000), 20_000)]).toHaveLength(20_000)
  })

  it('counts the length after taking things out, so hidden characters cannot use up the room', () => {
    expect(cleanText(`${chr(0x202e)}`.repeat(50) + 'abc', 5)).toBe('abc')
  })

  it('is empty for anything that is not text', () => {
    for (const value of [null, undefined, 5, {}, [], true]) expect(cleanText(value, 10)).toBe('')
  })
})

describe('cleanLine', () => {
  it('is one line: breaks become spaces, and it is trimmed and cut', () => {
    expect(cleanLine('  Fix\nthe\r\nlogin \t form  ', 100)).toBe('Fix the login form')
    expect(cleanLine('abcdefghij', 5)).toBe('abcde')
  })

  it('is not thrown off by white space that comes first, which is trimmed before it is cut', () => {
    expect(cleanLine(`${' '.repeat(10)}abc`, 5)).toBe('abc')
    expect(cleanLine(`\n\n\n\n\n\n\n\nabc`, 5)).toBe('abc')
  })

  it('takes out hidden characters and is empty for anything that is not text', () => {
    expect(cleanLine(`a${chr(0x202e)}b`, 10)).toBe('ab')
    expect(cleanLine(42, 10)).toBe('')
  })
})
