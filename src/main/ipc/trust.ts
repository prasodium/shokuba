export interface TrustedOrigins {
  /** http(s) origin of the Vite dev server. Only ever set for unpackaged builds. */
  devServerUrl?: string
  /** file:// URL of the built renderer entry point. */
  rendererFileUrl: string
}

/**
 * Is this URL one of *our* renderer pages? IPC handlers check the sender against this so
 * that a page loaded from anywhere else (a link that slipped through, an injected frame)
 * can never call into the main process.
 */
export function isTrustedSenderUrl(url: string, trusted: TrustedOrigins): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    if (!trusted.devServerUrl) return false
    try {
      return parsed.origin === new URL(trusted.devServerUrl).origin
    } catch {
      return false
    }
  }

  if (parsed.protocol === 'file:') {
    // Compare the path only, so a #hash or ?query on our own page still matches.
    return parsed.pathname === new URL(trusted.rendererFileUrl).pathname
  }

  return false
}
