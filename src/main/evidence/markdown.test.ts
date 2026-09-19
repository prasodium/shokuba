import { describe, expect, it } from 'vitest'
import { clean, fence, inline, shorten, slug, table } from './markdown'

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const RLO = String.fromCharCode(0x202e) // right-to-left override: can make text read backwards
const ZWSP = String.fromCharCode(0x200b)
const BOM = String.fromCharCode(0xfeff)

describe('clean', () => {
  it('drops control characters and the ones that disguise text, and keeps ordinary text', () => {
    expect(clean(`a${ESC}[31mb${BEL}c${RLO}d${ZWSP}e${BOM}f`)).toBe('a[31mbcdef')
    expect(clean('Zoë 日本語 — “quoted”')).toBe('Zoë 日本語 — “quoted”')
  })

  it('keeps line breaks and tabs only when asked, and treats all kinds of line break as one', () => {
    expect(clean('one\r\ntwo\rthree\nfour\tfive', true)).toBe('one\ntwo\nthree\nfour\tfive')
    expect(clean('one\ntwo')).toBe('onetwo')
  })
})

describe('inline', () => {
  it('shows text as a code span, so nothing in it is a link, an image or HTML', () => {
    expect(inline('[click](https://evil.invalid) ![x](https://evil.invalid/p.png)')).toBe(
      '`[click](https://evil.invalid) ![x](https://evil.invalid/p.png)`',
    )
    expect(inline('<img src=x onerror=alert(1)>')).toBe('`<img src=x onerror=alert(1)>`')
  })

  it('cannot be broken out of with backticks', () => {
    expect(inline('a `b` c')).toBe('``a `b` c``')
    expect(inline('a ``b`` c')).toBe('```a ``b`` c```')
    expect(inline('`starts and ends`')).toBe('`` `starts and ends` ``')
  })

  it('is one line, however many the text has, and says so when it has nothing', () => {
    expect(inline('one\n\n# a heading\r\n- an item')).toBe('`one # a heading - an item`')
    expect(inline('')).toBe('—')
    expect(inline(`  ${ESC}  `)).toBe('—')
  })

  it('keeps a table cell in its cell', () => {
    expect(inline('a | b', { cell: true })).toBe('`a \\| b`')
    expect(inline('a | b')).toBe('`a | b`')
  })

  it('cuts long text short', () => {
    const cut = inline('x'.repeat(500), { max: 20 })
    expect(cut).toBe('`' + 'x'.repeat(19) + '…`')
  })

  it('drops what could reverse or hide the text', () => {
    expect(inline(`abc${RLO}def`)).toBe('`abcdef`')
  })
})

describe('fence', () => {
  it('shows text in a block that keeps its line breaks and interprets nothing', () => {
    expect(fence('# not a heading\n[not](a link)')).toBe(
      '```text\n# not a heading\n[not](a link)\n```',
    )
  })

  it('cannot be closed early, whatever the text contains', () => {
    const out = fence('before\n```\n# now outside the block\n````\nafter')
    const marks = out.split('\n')[0]?.replace('text', '') ?? ''
    expect(marks.length).toBe(5) // longer than the longest run inside
    expect(out.endsWith('\n' + marks)).toBe(true)
    expect(out.split('\n').filter((line) => line === marks)).toHaveLength(1) // only the closing line
  })

  it('drops control characters and trailing blank lines, and cuts long text', () => {
    expect(fence(`a${ESC}[2Jb\n\n\n`)).toBe('```text\na[2Jb\n```')
    expect(fence('y'.repeat(100), 10)).toBe('```text\n' + 'y'.repeat(9) + '…\n```')
  })
})

describe('slug', () => {
  it('makes a plain file name from any text', () => {
    expect(slug('Build the login form!')).toBe('build-the-login-form')
    expect(slug('../../etc/passwd')).toBe('etc-passwd')
    expect(slug('C:\\Windows\\System32')).toBe('c-windows-system32')
    expect(slug('Zoë 日本語')).toBe('zoe')
  })

  it('never returns nothing, or something that starts or ends with a hyphen', () => {
    expect(slug('')).toBe('task')
    expect(slug('日本語')).toBe('task')
    expect(slug('---a---')).toBe('a')
    expect(slug('a'.repeat(10) + '-' + 'b'.repeat(50), 11)).toBe('aaaaaaaaaa')
  })
})

describe('shorten and table', () => {
  it('shortens by what a person sees', () => {
    expect(shorten('abc', 5)).toBe('abc')
    expect(shorten('abcdef', 4)).toBe('abc…')
    expect(shorten('😀😀😀😀', 3)).toBe('😀😀…')
  })

  it('writes a table', () => {
    expect(
      table(
        ['A', 'B'],
        [
          ['1', '2'],
          ['3', '4'],
        ],
      ),
    ).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')
  })
})
