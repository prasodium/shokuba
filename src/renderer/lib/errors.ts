/**
 * Electron wraps errors thrown in main as "Error invoking remote method 'channel': Error: msg".
 * Show people just the message.
 */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(\w+)?Error:\s*/, '')
}
