import { BREAKER_LEVELS, BREAKER_RULES } from '@shared/breaker'
import type { EventInput, ShokubaEvent } from '@shared/events/schema'
import { RUNTIME_STATES } from '@shared/types/agent'

/**
 * Generated event streams for testing replay and measuring it: realistic in shape (they pass the
 * event schema), random in content, and the same every time for the same seed. Test code only.
 */

/** A small seeded random number generator (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

export function generateStream(options: {
  seed: number
  length: number
  employees?: number
}): ShokubaEvent[] {
  const random = seeded(options.seed)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
  const people = Array.from({ length: options.employees ?? 12 }, (_, i) => `e${i}`)
  const hired: string[] = []
  const events: ShokubaEvent[] = []
  let ts = Date.UTC(2026, 0, 1)

  const push = (input: EventInput): void => {
    // Mostly a few hundred milliseconds apart, sometimes a long quiet, now and then a clock that
    // went backwards.
    const roll = random()
    ts += roll < 0.02 ? -500 : roll < 0.05 ? 600_000 : Math.floor(random() * 800)
    const seq = events.length + 1
    events.push({ ...input, seq, id: `id-${seq}`, ts: new Date(ts).toISOString() } as ShokubaEvent)
  }

  while (events.length < options.length) {
    const roll = random()
    const notHired = people.filter((p) => !hired.includes(p))
    if (hired.length === 0 || (roll < 0.03 && notHired.length > 0)) {
      const employeeId = pick(notHired.length > 0 ? notHired : people)
      if (!hired.includes(employeeId)) hired.push(employeeId)
      push({ type: 'agent.created', source: 'user', payload: { employeeId, providerId: 'mock' } })
      continue
    }
    const employeeId = pick(hired)
    if (roll < 0.04) {
      push({
        type: 'app.started',
        source: 'system',
        payload: { version: '0.0.1', platform: 'darwin' },
      })
    } else if (roll < 0.05) {
      hired.splice(hired.indexOf(employeeId), 1)
      push({
        type: 'employee.updated',
        source: 'user',
        payload: { employeeId, fields: ['archived'] },
      })
    } else if (roll < 0.1) {
      push({ type: 'agent.started', source: 'system', payload: { employeeId, pid: 100 } })
    } else if (roll < 0.5) {
      push({
        type: 'agent.state.changed',
        source: pick(['reported', 'inferred', 'simulated'] as const),
        payload: { employeeId, from: pick(RUNTIME_STATES), to: pick(RUNTIME_STATES) },
      })
    } else if (roll < 0.65) {
      push({
        type: 'agent.tool.started',
        source: 'reported',
        payload: { employeeId, toolName: pick(['Edit', 'Bash', 'Read']), summary: 'x' },
      })
    } else if (roll < 0.8) {
      push({
        type: 'agent.tool.finished',
        source: 'reported',
        payload: { employeeId, toolName: 'Edit', ok: random() < 0.9 },
      })
    } else if (roll < 0.84) {
      push({
        type: 'breaker.state.changed',
        source: 'system',
        payload: {
          employeeId,
          from: pick(BREAKER_LEVELS),
          to: pick(BREAKER_LEVELS),
          rule: pick(BREAKER_RULES),
        },
      })
    } else if (roll < 0.86) {
      push({
        type: 'agent.error',
        source: 'system',
        payload: { employeeId, code: 'E', message: 'failed' },
      })
    } else if (roll < 0.9) {
      push({
        type: 'agent.stopped',
        source: 'system',
        payload: { employeeId, exitCode: 0, signal: null },
      })
    } else if (roll < 0.95) {
      push({
        type: 'task.dispatched',
        source: 'system',
        payload: {
          taskId: `t${Math.floor(random() * 20)}`,
          missionId: 'm1',
          employeeId,
          attempt: 1,
        },
      })
    } else {
      push({
        type: 'task.assigned',
        source: 'user',
        payload: {
          taskId: `t${Math.floor(random() * 20)}`,
          missionId: 'm1',
          employeeId: random() < 0.2 ? null : employeeId,
        },
      })
    }
  }
  return events
}
