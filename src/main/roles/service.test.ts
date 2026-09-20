import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ROLE_TEMPLATES, builtinRoleId } from '@shared/roles'
import { createServices, type Services } from '../bootstrap'
import { createLogger } from '../logging/logger'
import { toPlatformId } from '../platform'
import { RoleError, type RoleService } from './service'

let dir: string
let services: Services
let roles: RoleService

const open = () =>
  createServices({
    dataDir: join(dir, 'data'),
    version: 'test',
    platform: toPlatformId(),
    logger: createLogger(() => {}),
  })

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'shokuba-roles-')))
  services = open()
  roles = services.roles
})

afterEach(() => {
  services.close()
  rmSync(dir, { recursive: true, force: true })
})

const mine = () => ({
  label: 'Architect',
  isManager: false,
  instructions: 'You design the system and keep it simple.',
  permissionMode: 'plan' as const,
})

const rejection = (fn: () => unknown): RoleError => {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(RoleError)
    return error as RoleError
  }
  throw new Error('expected a RoleError')
}

const events = (type: 'role.created' | 'role.updated') => services.events.log.list({ type })

describe('Shokuba’s own roles', () => {
  it('are there from the start, in order, with what Shokuba wrote', () => {
    const list = roles.list()
    expect(list.map((r) => r.id)).toEqual(ROLE_TEMPLATES.map((t) => builtinRoleId(t.id)))
    for (const [index, template] of ROLE_TEMPLATES.entries()) {
      expect(list[index]).toMatchObject({
        label: template.role,
        isManager: template.isManager,
        instructions: template.instructions,
        permissionMode: 'default',
        builtin: true,
      })
    }
  })

  it('are put in without being an event, since nobody did anything', () => {
    expect(events('role.created')).toEqual([])
    expect(events('role.updated')).toEqual([])
  })

  it('are put in only once: starting again adds none, and keeps an edit', () => {
    const engineer = builtinRoleId('engineer')
    roles.update(engineer, { instructions: 'Ship it.' })
    services.close()
    services = open()
    roles = services.roles
    expect(roles.list()).toHaveLength(ROLE_TEMPLATES.length)
    expect(roles.get(engineer)?.instructions).toBe('Ship it.')
  })

  it('come before yours even when one is put back after yours were made', () => {
    const custom = roles.create(mine())
    // One of Shokuba's own goes missing (say, from an older copy of the data), and is put back later.
    services.db.prepare('DELETE FROM roles WHERE id = ?').run(builtinRoleId('reviewer'))
    services.close()
    services = open()
    roles = services.roles
    const ids = roles.list().map((r) => r.id)
    expect(ids.at(-1)).toBe(custom.id)
    expect(ids.slice(0, -1).sort()).toEqual(ROLE_TEMPLATES.map((t) => builtinRoleId(t.id)).sort())
  })

  it('come before yours, however late yours were made', () => {
    roles.create(mine())
    expect(roles.list().map((r) => r.builtin)).toEqual([true, true, true, true, false])
  })
})

describe('RoleService.create', () => {
  it('makes a role of your own, with defaults, and lists it after Shokuba’s', () => {
    const role = roles.create({ label: 'Designer' })
    expect(role).toMatchObject({
      label: 'Designer',
      isManager: false,
      instructions: '',
      permissionMode: 'default',
      builtin: false,
    })
    expect(roles.list().at(-1)).toEqual(role)
    expect(roles.get(role.id)).toEqual(role)
  })

  it('keeps everything it is given, and trims', () => {
    const role = roles.create({ ...mine(), label: '  Architect  ', instructions: '  Design.  ' })
    expect(role).toMatchObject({
      label: 'Architect',
      instructions: 'Design.',
      permissionMode: 'plan',
    })
  })

  it('records that it was made, by id only', () => {
    const role = roles.create(mine())
    const [event] = events('role.created')
    expect(event).toMatchObject({ source: 'user', payload: { roleId: role.id } })
    expect(JSON.stringify(event)).not.toContain('design the system')
  })

  it('refuses what is not valid, and makes nothing', () => {
    const bad = [
      { ...mine(), label: '' },
      { ...mine(), label: '   ' },
      { ...mine(), label: 'x'.repeat(61) },
      { ...mine(), label: `bad${String.fromCharCode(0)}label` },
      { ...mine(), instructions: 'x'.repeat(2001) },
      { ...mine(), instructions: `a${String.fromCharCode(0)}b` },
      { ...mine(), permissionMode: 'bypassPermissions' as never },
      { ...mine(), extra: 1 } as never,
    ]
    for (const input of bad) expect(rejection(() => roles.create(input)).code).toBe('invalid')
    expect(roles.list()).toHaveLength(ROLE_TEMPLATES.length)
  })

  it('allows line breaks in instructions', () => {
    expect(roles.create({ ...mine(), instructions: 'One.\nTwo.' }).instructions).toBe('One.\nTwo.')
  })

  it('refuses a label that is taken, whatever the case, but not one that was removed', () => {
    expect(rejection(() => roles.create({ label: 'engineer' })).code).toBe('invalid')
    const role = roles.create(mine())
    expect(rejection(() => roles.create({ label: 'ARCHITECT' })).message).toContain('already')
    roles.archive(role.id)
    expect(roles.create(mine()).label).toBe('Architect')
  })
})

describe('RoleService.update', () => {
  it('changes only what is given, and says which', () => {
    const role = roles.create(mine())
    const updated = roles.update(role.id, { label: 'Lead architect', isManager: true })
    expect(updated).toMatchObject({
      label: 'Lead architect',
      isManager: true,
      instructions: mine().instructions,
      permissionMode: 'plan',
    })
    const [event] = events('role.updated')
    expect(event).toMatchObject({ payload: { roleId: role.id, fields: ['label', 'isManager'] } })
  })

  it('does nothing, and says nothing, when nothing would change', () => {
    const role = roles.create(mine())
    expect(roles.update(role.id, {})).toEqual(role)
    expect(roles.update(role.id, { label: role.label, isManager: false })).toEqual(role)
    expect(events('role.updated')).toEqual([])
  })

  it('can edit one of Shokuba’s own', () => {
    const id = builtinRoleId('qa')
    const updated = roles.update(id, { instructions: 'Break it.', permissionMode: 'acceptEdits' })
    expect(updated).toMatchObject({
      builtin: true,
      instructions: 'Break it.',
      permissionMode: 'acceptEdits',
    })
  })

  it('refuses a label taken by another role, but lets a role keep its own', () => {
    const role = roles.create(mine())
    expect(rejection(() => roles.update(role.id, { label: 'QA' })).code).toBe('invalid')
    expect(roles.update(role.id, { label: 'ARCHITECT' }).label).toBe('ARCHITECT')
  })

  it('refuses what is not valid, and changes nothing', () => {
    const role = roles.create(mine())
    for (const patch of [
      { label: '' },
      { instructions: 'x'.repeat(2001) },
      { permissionMode: 'nope' },
    ]) {
      expect(rejection(() => roles.update(role.id, patch as never)).code).toBe('invalid')
    }
    expect(roles.get(role.id)).toEqual(role)
  })

  it('reports a role that is not there, or was removed', () => {
    expect(rejection(() => roles.update('nope', { label: 'x' })).code).toBe('not-found')
    const role = roles.create(mine())
    roles.archive(role.id)
    expect(rejection(() => roles.update(role.id, { label: 'x' })).code).toBe('not-found')
  })
})

describe('RoleService.duplicate', () => {
  it('makes a role of your own with the same settings and a label that says it is a copy', () => {
    const copy = roles.duplicate(builtinRoleId('reviewer'))
    const original = roles.get(builtinRoleId('reviewer'))
    expect(copy).toMatchObject({
      label: 'Reviewer (copy)',
      isManager: original?.isManager,
      instructions: original?.instructions,
      permissionMode: original?.permissionMode,
      builtin: false,
    })
    expect(copy.id).not.toBe(original?.id)
    expect(events('role.created')).toHaveLength(1)
  })

  it('numbers further copies so no label is taken twice', () => {
    const labels = [1, 2, 3].map(() => roles.duplicate(builtinRoleId('qa')).label)
    expect(labels).toEqual(['QA (copy)', 'QA (copy 2)', 'QA (copy 3)'])
    // A copy of a copy does not pile up suffixes.
    const again = roles.duplicate(roles.list().find((r) => r.label === 'QA (copy)')?.id ?? '')
    expect(again.label).toBe('QA (copy 4)')
  })

  it('keeps a long label within the limit', () => {
    const long = roles.create({ label: 'x'.repeat(60) })
    const copy = roles.duplicate(long.id)
    expect(copy.label.length).toBeLessThanOrEqual(60)
    expect(copy.label.endsWith('(copy)')).toBe(true)
  })

  it('reports a role that is not there', () => {
    expect(rejection(() => roles.duplicate('nope')).code).toBe('not-found')
  })
})

describe('RoleService.archive', () => {
  it('removes one of your own from the list, and says so', () => {
    const role = roles.create(mine())
    roles.archive(role.id)
    expect(roles.get(role.id)).toBeUndefined()
    expect(roles.list().some((r) => r.id === role.id)).toBe(false)
    expect(events('role.updated').at(-1)).toMatchObject({
      payload: { roleId: role.id, fields: ['archived'] },
    })
  })

  it('will not remove one of Shokuba’s own, and leaves it there', () => {
    const error = rejection(() => roles.archive(builtinRoleId('manager')))
    expect(error.code).toBe('builtin')
    expect(error.message).toContain('reset')
    expect(roles.get(builtinRoleId('manager'))).toBeDefined()
    expect(events('role.updated')).toEqual([])
  })

  it('reports a role that is not there', () => {
    expect(rejection(() => roles.archive('nope')).code).toBe('not-found')
  })
})

describe('RoleService.reset', () => {
  it('puts one of Shokuba’s own back to what Shokuba wrote, all of it', () => {
    const id = builtinRoleId('manager')
    roles.update(id, {
      label: 'Boss',
      isManager: false,
      instructions: 'Rule.',
      permissionMode: 'plan',
    })
    const back = roles.reset(id)
    const template = ROLE_TEMPLATES.find((t) => t.id === 'manager')
    expect(back).toMatchObject({
      label: template?.role,
      isManager: true,
      instructions: template?.instructions,
      permissionMode: 'default',
      builtin: true,
    })
    expect(events('role.updated').at(-1)).toMatchObject({
      payload: { roleId: id, fields: ['reset'] },
    })
  })

  it('does nothing, and says nothing, for one that has not been changed', () => {
    const id = builtinRoleId('engineer')
    const before = roles.get(id)
    expect(roles.reset(id)).toEqual(before)
    expect(events('role.updated')).toEqual([])
  })

  it('has no original for one of your own', () => {
    const role = roles.create(mine())
    expect(rejection(() => roles.reset(role.id)).code).toBe('not-builtin')
  })

  it('will not make two roles share a label: the other has to be renamed first', () => {
    const id = builtinRoleId('qa')
    roles.update(id, { label: 'Testing' })
    roles.create({ label: 'QA' })
    expect(rejection(() => roles.reset(id)).code).toBe('invalid')
    expect(roles.get(id)?.label).toBe('Testing')
  })

  it('reports a role that is not there', () => {
    expect(rejection(() => roles.reset('nope')).code).toBe('not-found')
  })
})

describe('persistence', () => {
  it('keeps your roles, edits and removals across a restart', () => {
    const keep = roles.create(mine())
    const drop = roles.create({ label: 'Temp' })
    roles.archive(drop.id)
    roles.update(builtinRoleId('qa'), { instructions: 'Edited.' })
    services.close()
    services = open()
    roles = services.roles
    expect(roles.get(keep.id)).toEqual(keep)
    expect(roles.get(drop.id)).toBeUndefined()
    expect(roles.get(builtinRoleId('qa'))?.instructions).toBe('Edited.')
  })
})
