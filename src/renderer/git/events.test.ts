import { describe, expect, it } from 'vitest'
import type { ShokubaEvent } from '@shared/events/schema'
import { latestReviewSeq, latestWorkspaceSeq } from './events'

const workspace = (seq: number, taskId: string, missionId = 'm1'): ShokubaEvent =>
  ({
    seq,
    id: `e${seq}`,
    ts: 't',
    source: 'system',
    type: 'workspace.changed',
    payload: { taskId, missionId, change: 'created' },
  }) as unknown as ShokubaEvent
const other = (seq: number): ShokubaEvent =>
  ({
    seq,
    id: `e${seq}`,
    ts: 't',
    source: 'system',
    type: 'agent.ready',
    payload: { employeeId: 'x' },
  }) as unknown as ShokubaEvent

describe('latestWorkspaceSeq', () => {
  const events = [workspace(1, 't1'), other(2), workspace(3, 't2'), workspace(4, 't1'), other(5)]

  it('finds the newest workspace event for a task', () => {
    expect(latestWorkspaceSeq(events, { taskId: 't1' })).toBe(4)
    expect(latestWorkspaceSeq(events, { taskId: 't2' })).toBe(3)
  })

  it('finds the newest for a mission, whichever of its tasks it was about', () => {
    expect(latestWorkspaceSeq(events, { missionId: 'm1' })).toBe(4)
    expect(latestWorkspaceSeq(events, { missionId: 'other' })).toBe(0)
  })

  it('is 0 when there is nothing, so a view has something stable to depend on', () => {
    expect(latestWorkspaceSeq([], { taskId: 't1' })).toBe(0)
    expect(latestWorkspaceSeq([other(1)], { taskId: 't1' })).toBe(0)
  })

  it('changes when a new event for the task arrives, and not for someone else’s', () => {
    const before = latestWorkspaceSeq(events, { taskId: 't1' })
    expect(latestWorkspaceSeq([...events, workspace(6, 't9')], { taskId: 't1' })).toBe(before)
    expect(latestWorkspaceSeq([...events, workspace(6, 't1')], { taskId: 't1' })).toBe(6)
  })
})

describe('latestReviewSeq', () => {
  const review = (seq: number, taskId: string): ShokubaEvent =>
    ({
      seq,
      id: `e${seq}`,
      ts: 't',
      source: 'system',
      type: 'review.changed',
      payload: { taskId, missionId: 'm1', reviewId: 'r', reviewerId: 'x', change: 'requested' },
    }) as unknown as ShokubaEvent

  it('finds the newest review event for a task, and no other', () => {
    const events = [review(1, 't1'), other(2), review(3, 't2'), review(4, 't1'), other(5)]
    expect(latestReviewSeq(events, 't1')).toBe(4)
    expect(latestReviewSeq(events, 't2')).toBe(3)
    expect(latestReviewSeq(events, 't3')).toBe(0)
  })

  it('is 0 when there is nothing, so a view has something stable to depend on', () => {
    expect(latestReviewSeq([], 't1')).toBe(0)
    expect(latestReviewSeq([workspace(1, 't1')], 't1')).toBe(0)
  })
})
