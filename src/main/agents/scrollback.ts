/**
 * The last part of a terminal's output, kept so a terminal panel opened (or reopened)
 * later can show what happened. Bounded, so a chatty agent cannot grow memory forever.
 */
export class Scrollback {
  private text = ''
  private appended = 0

  constructor(private readonly maxChars = 200_000) {}

  /** Total characters ever appended. A chunk's stream position, so replay and live output can be joined without gaps or repeats. */
  get total(): number {
    return this.appended
  }

  append(data: string): void {
    this.appended += data.length
    this.text += data
    if (this.text.length <= this.maxChars) return

    let cut = this.text.length - this.maxChars
    // Start on a line boundary when there is one nearby, so the replay does not open mid-line.
    const newline = this.text.indexOf('\n', cut)
    if (newline !== -1 && newline - cut < 2_000) cut = newline + 1
    this.text = this.text.slice(cut)
  }

  read(): string {
    return this.text
  }
}
