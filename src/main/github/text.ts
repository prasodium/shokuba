/**
 * Text that came from GitHub, made safe to keep and to show. It is written by strangers, so it is
 * never trusted: it is plain text only, cut to a length, and stripped of the characters that could
 * hide or disguise something.
 *
 * What is removed: control characters (other than a newline and a tab), the characters that make
 * text run right-to-left or hide its order (the "trojan source" tricks), and a byte-order mark.
 * Line endings are made `\n`.
 */

const CUT = '…'

/** Characters that change how text is ordered or displayed without showing up themselves. */
const HIDDEN = /[\u202A-\u202E\u2066-\u2069\u200B\u2060\uFEFF\u00AD]/gu

/** `value` as clean text of at most `max` characters, or an empty string if it is not text. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const normal = value.replace(/\r\n?/g, '\n')
  const kept = [...normal]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0
      if (code === 0x0a || code === 0x09) return true
      return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0)
    })
    .join('')
    .replace(HIDDEN, '')
  const chars = [...kept]
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join('')}${CUT}` : kept
}

/** A single line: clean text with every line break turned into a space, and trimmed. */
export function cleanLine(value: unknown, max: number): string {
  return cleanText(value, max * 4)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}
