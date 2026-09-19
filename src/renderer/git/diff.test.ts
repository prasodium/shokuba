import { describe, expect, it } from 'vitest'
import type { FileChange } from '@shared/git'
import { classifyDiff, fileCounts, summarizeChanges } from './diff'

const file = (patch: Partial<FileChange>): FileChange => ({
  path: 'a.txt',
  added: 1,
  deleted: 0,
  binary: false,
  ...patch,
})

describe('classifyDiff', () => {
  const diff = [
    'diff --git a/a.txt b/a.txt',
    'index 1111111..2222222 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,3 +1,3 @@',
    ' one',
    '-two',
    '+TWO',
    ' three',
  ].join('\n')

  it('tells headers, hunks, additions, removals and context apart', () => {
    expect(classifyDiff(diff).map((line) => line.kind)).toEqual([
      'meta',
      'meta',
      'meta',
      'meta',
      'hunk',
      'context',
      'remove',
      'add',
      'context',
    ])
  })

  it('does not mistake the file headers for an addition and a removal', () => {
    const [remove, add] = classifyDiff('--- a/x\n+++ b/x\n')
    expect(remove?.kind).toBe('meta')
    expect(add?.kind).toBe('meta')
  })

  it('keeps every line’s text exactly, so nothing is lost or altered', () => {
    expect(
      classifyDiff(diff)
        .map((line) => line.text)
        .join('\n'),
    ).toBe(diff)
  })

  it('treats markup in a file as plain text', () => {
    const [line] = classifyDiff('+<script>alert(1)</script>')
    expect(line).toEqual({ kind: 'add', text: '+<script>alert(1)</script>' })
  })

  it('handles an empty diff and Windows line endings', () => {
    expect(classifyDiff('')).toEqual([])
    expect(classifyDiff('+a\r\n-b\r\n').map((line) => line.text)).toEqual(['+a', '-b'])
  })

  it('marks binary files as header lines', () => {
    expect(classifyDiff('Binary files a/x and b/x differ')[0]?.kind).toBe('meta')
  })
})

describe('summarizing changes', () => {
  it('counts files and lines', () => {
    expect(summarizeChanges([file({ added: 12, deleted: 4 })])).toBe('1 file, +12 −4')
    expect(
      summarizeChanges([file({ added: 2, deleted: 1 }), file({ path: 'b', added: 3, deleted: 0 })]),
    ).toBe('2 files, +5 −1')
  })

  it('says so when nothing changed', () => {
    expect(summarizeChanges([])).toBe('no changes')
  })

  it('leaves binary files out of the line counts', () => {
    expect(
      summarizeChanges([
        file({ added: 2, deleted: 0 }),
        file({ path: 'p.png', added: null, deleted: null, binary: true }),
      ]),
    ).toBe('2 files, +2 −0')
  })

  it('shows a file’s own counts, or that it is binary', () => {
    expect(fileCounts(file({ added: 3, deleted: 1 }))).toBe('+3 −1')
    expect(fileCounts(file({ added: null, deleted: null, binary: true }))).toBe('binary')
  })
})
