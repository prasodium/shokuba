import { describe, expect, it } from 'vitest'
import { DESK_SLOTS, MAX_VISIBLE_EMPLOYEES, ROOM_DEPTH, ROOM_WIDTH, assignDesks } from './layout'

describe('assignDesks', () => {
  it('seats each employee at their own desk, in order', () => {
    const { seated, overflow } = assignDesks(['a', 'b'])
    expect(seated.map((s) => s.employee)).toEqual(['a', 'b'])
    expect(seated[0]?.slot).toEqual(DESK_SLOTS[0])
    expect(seated[1]?.slot).toEqual(DESK_SLOTS[1])
    expect(overflow).toBe(0)
  })

  it('reports how many did not fit', () => {
    const { seated, overflow } = assignDesks(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(seated).toHaveLength(MAX_VISIBLE_EMPLOYEES)
    expect(overflow).toBe(2)
  })

  it('handles an empty office', () => {
    expect(assignDesks([])).toEqual({ seated: [], overflow: 0 })
  })
})

describe('desk slots', () => {
  it('all fit inside the room, with space for the chair and desk', () => {
    for (const slot of DESK_SLOTS) {
      expect(slot.x).toBeGreaterThan(0)
      expect(slot.y).toBeGreaterThan(0)
      expect(slot.x + 1.8).toBeLessThan(ROOM_WIDTH)
      expect(slot.y + 2.0).toBeLessThan(ROOM_DEPTH)
    }
  })

  it('never overlap each other', () => {
    for (const a of DESK_SLOTS) {
      for (const b of DESK_SLOTS) {
        if (a === b) continue
        const separated = Math.abs(a.x - b.x) >= 1.8 || Math.abs(a.y - b.y) >= 2.0
        expect(separated).toBe(true)
      }
    }
  })
})
