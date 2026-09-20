import { describe, expect, it } from 'vitest'
import type { ShokubaEvent } from '@shared/events/schema'
import { NOTE_MAX_CHARS, NOTE_MS, NoteBoard, notesFor, oneLine, type TalkContext } from './talk'

let seq = 0
const sent = (fromId: string, toId: string, conversationId = 'c1'): ShokubaEvent =>
  ({
    seq: (seq += 1),
    id: `e${seq}`,
    ts: 't',
    source: 'system',
    type: 'message.sent',
    payload: { messageId: `m${seq}`, conversationId, fromId, toId, kind: 'inform', hop: 1 },
  }) as ShokubaEvent

const names: Record<string, string> = { ava: 'Ava', bo: 'Bo' }
const subjects: Record<string, string> = { c1: 'Login form review', c2: '' }
const ctx: TalkContext = {
  subjectOf: (id) => subjects[id] ?? null,
  nameOf: (id) => names[id] ?? null,
}

describe('notesFor', () => {
  it('puts one note over the sender and one over the recipient, with the real subject', () => {
    expect(notesFor(sent('ava', 'bo'), ctx)).toEqual([
      { employeeId: 'ava', text: 'to Bo: Login form review' },
      { employeeId: 'bo', text: 'from Ava: Login form review' },
    ])
  })

  it('has only the employee’s note when the other side is you, and calls you "you"', () => {
    expect(notesFor(sent('human', 'ava'), ctx)).toEqual([
      { employeeId: 'ava', text: 'from you: Login form review' },
    ])
    expect(notesFor(sent('ava', 'human'), ctx)).toEqual([
      { employeeId: 'ava', text: 'to you: Login form review' },
    ])
  })

  it('leaves the subject out when it is not known, and never makes one up', () => {
    expect(notesFor(sent('ava', 'bo', 'unknown'), ctx).map((n) => n.text)).toEqual([
      'to Bo',
      'from Ava',
    ])
    // An empty subject is not a subject either.
    expect(notesFor(sent('ava', 'bo', 'c2'), ctx).map((n) => n.text)).toEqual(['to Bo', 'from Ava'])
  })

  it('does not name an employee it does not know', () => {
    const texts = notesFor(sent('ava', 'gone'), ctx).map((n) => n.text)
    expect(texts[0]).toBe('to someone: Login form review')
  })

  it('says nothing for a note to oneself', () => {
    expect(notesFor(sent('ava', 'ava'), ctx)).toEqual([])
  })

  it('says nothing for an event that is not a message', () => {
    const other = {
      seq: 1,
      id: 'e',
      ts: 't',
      source: 'system',
      type: 'agent.ready',
      payload: { employeeId: 'ava' },
    } as unknown as ShokubaEvent
    expect(notesFor(other, ctx)).toEqual([])
  })

  it('makes a long subject fit on one line', () => {
    const long: TalkContext = { ...ctx, subjectOf: () => 'x'.repeat(300) }
    for (const note of notesFor(sent('ava', 'bo'), long)) {
      expect([...note.text].length).toBeLessThanOrEqual(NOTE_MAX_CHARS)
      expect(note.text.endsWith('…')).toBe(true)
    }
  })
})

describe('oneLine', () => {
  it('leaves a short line as it is', () => {
    expect(oneLine('Fix the login form')).toBe('Fix the login form')
  })

  it('turns newlines, tabs and runs of space into single spaces, and trims', () => {
    expect(oneLine('  Fix\nthe\t\tlogin \r\n form  ')).toBe('Fix the login form')
  })

  it('turns other control characters into spaces so they never draw as boxes', () => {
    expect(
      oneLine(
        `a${String.fromCharCode(0)}b${String.fromCharCode(0x1b)}c${String.fromCharCode(0x7f)}d`,
      ),
    ).toBe('a b c d')
  })

  it('cuts at the limit with an ellipsis, so the result is never longer than the limit', () => {
    const cut = oneLine('abcdefghij', 5)
    expect(cut).toBe('abcd…')
    expect(oneLine('abcde', 5)).toBe('abcde')
    expect(oneLine('abcdef', 5)).toBe('abcd…')
  })

  it('counts a character, not a code unit, so an emoji is never cut in half', () => {
    const line = oneLine('😀😀😀😀😀😀', 4)
    expect(line).toBe('😀😀😀…')
    expect([...line]).toHaveLength(4)
  })

  it('does not change what is not a control or a space', () => {
    expect(oneLine('Ünïcode — “quotes” 日本語')).toBe('Ünïcode — “quotes” 日本語')
  })
})

describe('NoteBoard', () => {
  it('shows a note for a few seconds, then not', () => {
    const board = new NoteBoard()
    board.say([{ employeeId: 'ava', text: 'to Bo: hi' }], 1_000)
    expect(board.active(1_000).get('ava')).toBe('to Bo: hi')
    expect(board.active(1_000 + NOTE_MS - 1).get('ava')).toBe('to Bo: hi')
    expect(board.active(1_000 + NOTE_MS).has('ava')).toBe(false)
  })

  it('shows the newest note over an employee, and starts its time afresh', () => {
    const board = new NoteBoard()
    board.say([{ employeeId: 'ava', text: 'first' }], 0)
    board.say([{ employeeId: 'ava', text: 'second' }], 4_000)
    expect(board.active(5_000).get('ava')).toBe('second')
    // The first would be over by now; the second has two seconds left.
    expect(board.active(NOTE_MS + 1_000).get('ava')).toBe('second')
    expect(board.active(4_000 + NOTE_MS).has('ava')).toBe(false)
  })

  it('keeps one employee’s note apart from another’s', () => {
    const board = new NoteBoard()
    board.say(
      [
        { employeeId: 'ava', text: 'a' },
        { employeeId: 'bo', text: 'b' },
      ],
      0,
    )
    expect([...board.active(1).entries()]).toEqual([
      ['ava', 'a'],
      ['bo', 'b'],
    ])
  })

  it('forgets everything when cleared', () => {
    const board = new NoteBoard()
    board.say([{ employeeId: 'ava', text: 'a' }], 0)
    board.clear()
    expect(board.active(1).size).toBe(0)
  })

  it('shows nothing before anything is said', () => {
    expect(new NoteBoard().active(0).size).toBe(0)
  })
})
