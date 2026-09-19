/**
 * Secret redaction. Applied to anything that is persisted, logged or sent to the UI.
 *
 * This is a safety net, not a guarantee: it catches well-known token shapes and
 * secret-looking keys. The primary defence is not putting secrets where they can be
 * logged in the first place (see safeChildEnv).
 */

const REDACTED = (kind: string): string => `[REDACTED:${kind}]`

interface Rule {
  kind: string
  pattern: RegExp
  /** Replace only this capture group, keeping the surrounding context. */
  group?: number
}

// Every pattern is linear-time: no nested quantifiers over overlapping classes.
const RULES: readonly Rule[] = [
  {
    kind: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { kind: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: 'api-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { kind: 'github-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { kind: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  { kind: 'bearer-token', pattern: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/g, group: 1 },
  // https://user:password@host  ->  keep user and host, drop the password
  { kind: 'url-credentials', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/gi, group: 1 },
  // API_KEY=..., "password": "...", token: ..., Authorization: Bearer <value>
  {
    kind: 'secret-assignment',
    pattern:
      /\b(?:api[_-]?key|secret|token|password|passwd|authorization)\b["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic)\s+)?([^\s"',;]{6,})/gi,
    group: 1,
  },
]

/** Apply one rule, calling `onFound` for each secret it replaces. */
function applyRule(input: string, rule: Rule, onFound?: () => void): string {
  return input.replace(rule.pattern, (match: string, ...args: unknown[]) => {
    if (rule.group === undefined) {
      onFound?.()
      return REDACTED(rule.kind)
    }
    const captured = args[rule.group - 1]
    // Something already redacted is not a secret any more.
    if (typeof captured !== 'string' || captured.startsWith('[REDACTED:')) return match
    onFound?.()
    // The secret is the last thing before the end of the match (or a closing "@"), and it
    // can legitimately equal earlier text such as the key name ("secret=secret"), so
    // replace the *last* occurrence rather than the first.
    const at = match.lastIndexOf(captured)
    return match.slice(0, at) + REDACTED(rule.kind) + match.slice(at + captured.length)
  })
}

export function redactString(input: string): string {
  let out = input
  for (const rule of RULES) out = applyRule(out, rule)
  return out
}

/**
 * What kinds of secret-looking text `input` holds and how many of each, never the text itself. For
 * telling a person a file may hold a secret before they share it, when the file must be kept exactly
 * as it is and so cannot be redacted. It follows the redactor's own order, so a secret that one rule
 * has claimed is not counted again by a broader one.
 */
export function scanSecrets(input: string): Array<{ kind: string; count: number }> {
  const counts = new Map<string, number>()
  let text = input
  for (const rule of RULES) {
    text = applyRule(text, rule, () => counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + 1))
  }
  return [...counts].map(([kind, count]) => ({ kind, count }))
}

const SENSITIVE_SUFFIXES = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'authorization',
  'cookie',
  'privatekey',
] as const
const MAX_DEPTH = 24

/** "githubToken", "GITHUB_TOKEN" and "github-token" are all sensitive; "tokenCount" is not. */
function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[_-]/g, '')
  return SENSITIVE_SUFFIXES.some((suffix) => normalised.endsWith(suffix))
}

/**
 * Deep-copy a JSON-like value with secrets removed. String values under keys that look
 * sensitive are replaced wholesale, whatever they contain. Non-string values (numbers,
 * booleans, null) keep their type so schemas still validate after redaction.
 *
 * Redact *before* validating: redaction can lengthen a string, and what gets stored
 * must be exactly what passed validation.
 */
export function redactDeep<T>(value: T): T {
  return walk(value, 0) as T
}

function walk(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED]'
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      out[key] =
        typeof inner === 'string' && inner !== '' && isSensitiveKey(key)
          ? REDACTED('sensitive-key')
          : walk(inner, depth + 1)
    }
    return out
  }
  return value
}
