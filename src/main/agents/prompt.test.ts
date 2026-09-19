import { describe, expect, it } from 'vitest'
import { bracketedPaste, PASTE_END, PASTE_START, sanitizePrompt } from './prompt'

const ESC = String.fromCharCode(27)

describe('sanitizePrompt', () => {
  it('keeps ordinary text, line breaks, tabs and non-ASCII', () => {
    expect(sanitizePrompt('Line one\n\tindented 職場 — ok')).toBe('Line one\n\tindented 職場 — ok')
  })

  it('normalises Windows and old-Mac line endings', () => {
    expect(sanitizePrompt('a\r\nb\rc')).toBe('a\nb\nc')
  })

  it('drops escape, NUL, DEL and other control characters', () => {
    const dirty = `a${ESC}[31mb${String.fromCharCode(0)}c${String.fromCharCode(127)}d${String.fromCharCode(7)}e`
    expect(sanitizePrompt(dirty)).toBe('a[31mbcde')
  })

  it('drops C1 control characters too', () => {
    expect(sanitizePrompt(`a${String.fromCharCode(0x9b)}b`)).toBe('ab')
  })

  it('cannot smuggle in the end-of-paste marker', () => {
    const attack = `harmless${PASTE_END}rm -rf / \r`
    const cleaned = sanitizePrompt(attack)
    expect(cleaned).not.toContain(ESC)
    expect(cleaned).not.toContain(PASTE_END)
  })

  it('trims and bounds length', () => {
    expect(sanitizePrompt('  hi  ')).toBe('hi')
    expect(sanitizePrompt('x'.repeat(50_000)).length).toBeLessThanOrEqual(20_000)
  })
})

describe('bracketedPaste', () => {
  it('wraps the cleaned text in the paste markers, exactly once each', () => {
    const paste = bracketedPaste(`hello${ESC}[201~evil`)
    expect(paste.startsWith(PASTE_START)).toBe(true)
    expect(paste.endsWith(PASTE_END)).toBe(true)
    expect(paste.split(ESC).length - 1).toBe(2)
    expect(paste.slice(PASTE_START.length, -PASTE_END.length)).toBe('hello[201~evil')
  })

  it('uses the standard bracketed-paste sequences', () => {
    expect(PASTE_START).toBe(`${ESC}[200~`)
    expect(PASTE_END).toBe(`${ESC}[201~`)
  })
})
