import { redactDeep } from '../security/redact'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

export type LogSink = (level: LogLevel, line: string) => void

const consoleSink: LogSink = (level, line) => {
  if (level === 'error' || level === 'warn') console.error(line)
  else console.log(line)
}

/** Serialise an unknown thrown value without ever dumping a huge or circular object. */
export function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message }
  return { name: 'NonError', message: String(error) }
}

/**
 * Structured (one JSON object per line) logger. Every field passes through the
 * redactor, so a stray token in an error message cannot reach the log.
 */
export function createLogger(
  sink: LogSink = consoleSink,
  now: () => Date = () => new Date(),
): Logger {
  const write =
    (level: LogLevel) =>
    (event: string, fields: Record<string, unknown> = {}): void => {
      // Reserved keys go last so a caller's field can never overwrite them.
      sink(level, JSON.stringify({ ...redactDeep(fields), level, event, ts: now().toISOString() }))
    }
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') }
}
