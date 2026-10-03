/**
 * Whether the window is replaying. Kept apart from the stores so the guard on the API can read it
 * without depending on them.
 */
let replaying = false

export function isReplaying(): boolean {
  return replaying
}

export function setReplaying(value: boolean): void {
  replaying = value
}
