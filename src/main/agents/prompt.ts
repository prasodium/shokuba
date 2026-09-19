const MAX_PROMPT_CHARS = 20_000

/** The escape character that starts terminal control sequences. */
const ESC = String.fromCharCode(0x1b)

/** Start and end of a bracketed paste: the terminal's way to say "this is pasted text". */
export const PASTE_START = `${ESC}[200~`
export const PASTE_END = `${ESC}[201~`

/**
 * Make text safe to paste into an agent's terminal. Everything except line breaks and tabs
 * that is a control character is dropped. That matters: an escape character in a task
 * description could otherwise end the bracketed paste early and have the rest typed as if
 * by a person (including an Enter that answers a permission prompt).
 */
export function sanitizePrompt(text: string): string {
  const normalised = text.replace(/\r\n?/g, '\n')
  let out = ''
  for (const char of normalised) {
    const code = char.charCodeAt(0)
    if (code === 0x0a || code === 0x09) out += char
    else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) continue
    else out += char
  }
  return out.slice(0, MAX_PROMPT_CHARS).trim()
}

/** The bytes that deliver `text` as one pasted block (the caller sends Enter afterwards). */
export function bracketedPaste(text: string): string {
  return `${PASTE_START}${sanitizePrompt(text)}${PASTE_END}`
}
