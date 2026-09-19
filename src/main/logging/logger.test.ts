import { describe, expect, it } from 'vitest'
import { createLogger, describeError, type LogLevel } from './logger'

const capture = () => {
  const lines: { level: LogLevel; entry: Record<string, unknown> }[] = []
  const logger = createLogger(
    (level, line) => lines.push({ level, entry: JSON.parse(line) as Record<string, unknown> }),
    () => new Date('2026-09-19T10:00:00.000Z'),
  )
  return { lines, logger }
}

describe('createLogger', () => {
  it('writes one structured JSON object per call', () => {
    const { lines, logger } = capture()
    logger.info('agent.task.started', { agentId: 'alice', taskId: 'task_42' })
    expect(lines).toEqual([
      {
        level: 'info',
        entry: {
          level: 'info',
          event: 'agent.task.started',
          ts: '2026-09-19T10:00:00.000Z',
          agentId: 'alice',
          taskId: 'task_42',
        },
      },
    ])
  })

  it('redacts secrets in fields', () => {
    const { lines, logger } = capture()
    logger.error('spawn.failed', { apiKey: 'plain', message: 'API_KEY=abcdef123456 was rejected' })
    expect(lines[0]?.entry['apiKey']).toBe('[REDACTED:sensitive-key]')
    expect(lines[0]?.entry['message']).toBe('API_KEY=[REDACTED:secret-assignment] was rejected')
  })

  it('does not let a field overwrite the reserved level, event or ts keys', () => {
    const { lines, logger } = capture()
    logger.warn('real.event', { level: 'debug', event: 'fake.event', ts: 'yesterday' })
    expect(lines[0]?.entry).toMatchObject({
      level: 'warn',
      event: 'real.event',
      ts: '2026-09-19T10:00:00.000Z',
    })
  })
})

describe('describeError', () => {
  it('extracts name and message from Errors', () => {
    expect(describeError(new TypeError('boom'))).toEqual({ name: 'TypeError', message: 'boom' })
  })

  it('handles thrown non-errors', () => {
    expect(describeError('nope')).toEqual({ name: 'NonError', message: 'nope' })
  })
})
