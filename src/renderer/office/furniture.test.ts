import { describe, expect, it } from 'vitest'
import { STATION_DEPTH, STATION_WIDTH, chairBoxes, deskBoxes, personBoxes, rug } from './furniture'
import { poseFor } from './pose'

const everything = () => [
  rug(0xe8893a),
  ...chairBoxes(),
  ...personBoxes(poseFor('coding', 0.05), 0xe8893a),
  ...deskBoxes(),
]

describe('workstation geometry', () => {
  it('keeps every box inside the station footprint and above the floor', () => {
    for (const b of everything()) {
      expect(b.z).toBeGreaterThanOrEqual(0)
      expect(b.w).toBeGreaterThan(0)
      expect(b.d).toBeGreaterThan(0)
      expect(b.h).toBeGreaterThan(0)
      // The rug deliberately overhangs the station a little.
      expect(b.x).toBeGreaterThanOrEqual(-0.2)
      expect(b.y).toBeGreaterThanOrEqual(-0.2)
      expect(b.x + b.w).toBeLessThanOrEqual(STATION_WIDTH + 0.2)
      expect(b.y + b.d).toBeLessThanOrEqual(STATION_DEPTH + 0.3)
    }
  })

  it('seats nobody when the agent is offline', () => {
    expect(personBoxes(poseFor('offline', 0), 0xe8893a)).toEqual([])
  })

  it('dresses the employee in their chosen colour', () => {
    const shirt = 0x3366cc
    expect(personBoxes(poseFor('idle', 0), shirt).some((b) => b.color === shirt)).toBe(true)
  })

  it('moves the arms with the pose, so typing is visible', () => {
    const still = personBoxes(poseFor('idle', 0), 0x123456)
    const typing = personBoxes({ ...poseFor('coding', 0), leftArmDz: 0.04 }, 0x123456)
    expect(typing.some((b, i) => b.z !== still[i]?.z)).toBe(true)
  })

  it('raises the right arm when the agent needs attention', () => {
    const idle = personBoxes(poseFor('idle', 0), 0x123456)
    const waiting = personBoxes(poseFor('waiting', 0), 0x123456)
    const rightArm = (boxes: typeof idle) => boxes.find((b) => b.x === 1.04)?.z ?? 0
    expect(rightArm(waiting)).toBeGreaterThan(rightArm(idle) + 0.3)
  })

  it('puts the desk in front of (at larger y than) the person', () => {
    const desk = deskBoxes().find((b) => b.w > 1.5)
    const torso = personBoxes(poseFor('idle', 0), 0x123456).find((b) => b.h === 0.48)
    expect(desk?.y ?? 0).toBeGreaterThan((torso?.y ?? 99) + (torso?.d ?? 0) / 2)
  })
})
