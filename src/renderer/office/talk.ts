import type { ShokubaEvent } from '@shared/events/schema'
import { HUMAN } from '@shared/messages'

/**
 * Real messages, shown. When one employee really messages another (or you), a small note with the
 * message's REAL subject appears over the employees involved for a few seconds. The subject is
 * shown as written, only made to fit on one line, and never composed here: a note says who it is
 * to or from, and the subject, and nothing else. If the subject is not known the note leaves it
 * out. It is a picture of a recorded message, so it carries no `simulated` mark.
 *
 * Pure: an event goes in and notes come out, and the board of notes takes its time as an argument.
 */

/** How long a note stays. */
export const NOTE_MS = 6_000
/** The longest a note's text is drawn; the rest is cut with an ellipsis. */
export const NOTE_MAX_CHARS = 48

/** What to show over one employee. */
export interface Note {
  employeeId: string
  text: string
}

/** What a note needs to know that the event does not say. */
export interface TalkContext {
  /** The subject of a conversation, or null if it is not known. */
  subjectOf(conversationId: string): string | null
  /** An employee's name, or null if they are not known. */
  nameOf(employeeId: string): string | null
}

/** Text as one line: control characters and runs of white space become one space, and it is cut to fit. */
export function oneLine(text: string, max = NOTE_MAX_CHARS): string {
  // Control characters (a newline in a subject, say) would break the line or draw as boxes.
  const flat = [...text]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0
      return code < 0x20 || code === 0x7f ? ' ' : char
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = [...flat]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat
}

/** Who someone is called in a note: you are "you", an employee is their name. */
function called(id: string, ctx: TalkContext): string {
  if (id === HUMAN) return 'you'
  return ctx.nameOf(id) ?? 'someone'
}

function line(direction: 'to' | 'from', other: string, subject: string | null): string {
  return oneLine(subject ? `${direction} ${other}: ${subject}` : `${direction} ${other}`)
}

/** The notes this event calls for: one for the sender and one for the recipient, unless that is you. */
export function notesFor(event: ShokubaEvent, ctx: TalkContext): Note[] {
  if (event.type !== 'message.sent') return []
  const { fromId, toId, conversationId } = event.payload
  if (fromId === toId) return []
  const subject = ctx.subjectOf(conversationId)
  const notes: Note[] = []
  if (fromId !== HUMAN) {
    notes.push({ employeeId: fromId, text: line('to', called(toId, ctx), subject) })
  }
  if (toId !== HUMAN) {
    notes.push({ employeeId: toId, text: line('from', called(fromId, ctx), subject) })
  }
  return notes
}

/** The notes on show. The newest one over an employee is the one they show, until it runs out. */
export class NoteBoard {
  private readonly notes = new Map<string, { text: string; until: number }>()

  say(notes: readonly Note[], now: number): void {
    for (const note of notes)
      this.notes.set(note.employeeId, { text: note.text, until: now + NOTE_MS })
  }

  /** What is on show at `now`, by employee. */
  active(now: number): Map<string, string> {
    const shown = new Map<string, string>()
    for (const [id, note] of this.notes) {
      if (now < note.until) shown.set(id, note.text)
      else this.notes.delete(id)
    }
    return shown
  }

  clear(): void {
    this.notes.clear()
  }
}
