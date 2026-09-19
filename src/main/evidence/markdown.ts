/**
 * Helpers for writing Markdown that contains text someone else wrote (a task description, an
 * agent's summary, a reviewer's finding, a commit subject, an employee's name).
 *
 * That text is untrusted. In a Markdown viewer it could otherwise become a link, an image that
 * loads from the internet, HTML, or headings and tables that break the report's structure, and a
 * report is often opened in exactly such a viewer. So all such text is shown as a code span or a
 * fenced block, where nothing is interpreted, and characters that could disguise it (control
 * characters, and the ones that reverse the direction of text) are dropped first.
 */

const ELLIPSIS = '…'

/** Whether a character must never reach a report: it is invisible, or can disguise what is shown. */
function isUnsafe(code: number, keepLineBreaks: boolean): boolean {
  if (code === 0x0a) return !keepLineBreaks
  if (code === 0x09) return false
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) || // zero-width characters and direction marks
    (code >= 0x2028 && code <= 0x202e) || // line and paragraph separators, direction overrides
    (code >= 0x2066 && code <= 0x2069) || // direction isolates
    code === 0xfeff
  )
}

/** The text with everything that could disguise it removed; line breaks are kept only if asked. */
export function clean(text: string, keepLineBreaks = false): string {
  let out = ''
  for (const char of text.replace(/\r\n?/g, '\n')) {
    if (!isUnsafe(char.codePointAt(0) ?? 0, keepLineBreaks)) out += char
  }
  return out
}

function longestRun(text: string, char: string): number {
  let longest = 0
  let run = 0
  for (const c of text) {
    run = c === char ? run + 1 : 0
    if (run > longest) longest = run
  }
  return longest
}

/** At most `max` characters, counting what a person sees, with an ellipsis if it was cut. */
export function shorten(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : chars.slice(0, Math.max(0, max - 1)).join('') + ELLIPSIS
}

interface InlineOptions {
  /** The longest the text may be before it is cut short. */
  max?: number
  /** It sits in a table cell, so a vertical bar must not end the cell. */
  cell?: boolean
}

/** Short text as a code span: one line, and nothing in it is interpreted. */
export function inline(text: string, options: InlineOptions = {}): string {
  const flat = shorten(clean(text, true).replace(/\s+/g, ' ').trim(), options.max ?? 200)
  if (flat === '') return '—'
  const ticks = '`'.repeat(longestRun(flat, '`') + 1)
  // A code span that starts or ends with a backtick needs a space inside to be read correctly.
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : ''
  const body = options.cell ? flat.replace(/\|/g, '\\|') : flat
  return `${ticks}${pad}${body}${pad}${ticks}`
}

/** Longer text, line breaks kept, as a fenced block that no line inside it can close early. */
export function fence(text: string, max = 20_000): string {
  const body = shorten(clean(text, true), max).replace(/\n+$/, '')
  const marks = '`'.repeat(Math.max(3, longestRun(body, '`') + 1))
  return `${marks}text\n${body}\n${marks}`
}

/**
 * Text with anything that looks like a full path replaced by `[path]`. For the notes Shokuba keeps
 * about why a task had no folder of its own, which can come from an error naming a file. (What the
 * checks printed, and the code itself, are kept as they were and may hold any path.)
 */
export function scrubPaths(text: string): string {
  return text.replace(/(?<=^|[\s"'(])(?:[A-Za-z]:\\|\\\\|\/)[^\s"')]+/g, '[path]')
}

/** A name that is safe to use for a file or folder: lower-case letters, digits and hyphens. */
export function slug(text: string, max = 40): string {
  const plain = text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
  return plain === '' ? 'task' : plain
}

/** A table: the header row, then a row per entry. Cells are already made safe by the caller. */
export function table(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n')
}
