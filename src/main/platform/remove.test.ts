import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { toPlatformId } from './platform'
import { removeTree } from './remove'

let dir: string
const windows = toPlatformId() === 'win32'

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'shokuba-remove-')))
})

afterEach(() => {
  // Make anything a test locked deletable again, so the test folder itself can go.
  try {
    chmodSync(join(dir, 'tree', 'locked'), 0o700)
  } catch {
    /* nothing was locked */
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('removeTree', () => {
  it('removes a folder and everything in it', async () => {
    mkdirSync(join(dir, 'tree', 'a', 'b'), { recursive: true })
    writeFileSync(join(dir, 'tree', 'a', 'b', 'file.txt'), 'x')
    await removeTree(join(dir, 'tree'))
    expect(existsSync(join(dir, 'tree'))).toBe(false)
  })

  it('is fine with something that is already gone', async () => {
    await expect(removeTree(join(dir, 'nothing-here'))).resolves.toBeUndefined()
  })

  it('removes read-only files, the way Git leaves its object files', async () => {
    mkdirSync(join(dir, 'tree', 'objects'), { recursive: true })
    const file = join(dir, 'tree', 'objects', 'blob')
    writeFileSync(file, 'x')
    chmodSync(file, 0o444)
    await removeTree(join(dir, 'tree'))
    expect(existsSync(join(dir, 'tree'))).toBe(false)
  })

  it.skipIf(windows)(
    'removes a folder whose contents cannot be deleted until it is made writable',
    async () => {
      mkdirSync(join(dir, 'tree', 'locked'), { recursive: true })
      writeFileSync(join(dir, 'tree', 'locked', 'file.txt'), 'x')
      chmodSync(join(dir, 'tree', 'locked'), 0o555)
      await removeTree(join(dir, 'tree'))
      expect(existsSync(join(dir, 'tree'))).toBe(false)
    },
  )

  it.skipIf(windows)('never follows a link out of the folder', async () => {
    mkdirSync(join(dir, 'outside'))
    const precious = join(dir, 'outside', 'precious.txt')
    writeFileSync(precious, 'keep')
    chmodSync(precious, 0o444)
    mkdirSync(join(dir, 'tree', 'locked'), { recursive: true })
    symlinkSync(join(dir, 'outside'), join(dir, 'tree', 'locked', 'link'))
    chmodSync(join(dir, 'tree', 'locked'), 0o555)
    await removeTree(join(dir, 'tree'))
    expect(existsSync(join(dir, 'tree'))).toBe(false)
    // The linked folder and its file were neither deleted nor made writable.
    expect(existsSync(precious)).toBe(true)
    expect((await import('node:fs')).statSync(precious).mode & 0o222).toBe(0)
  })
})
