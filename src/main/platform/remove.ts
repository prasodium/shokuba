import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 3, retryDelay: 100 } as const

/**
 * Delete a folder and everything in it, including files marked read-only. Git makes its object
 * files read-only, and Node's own recursive delete cannot remove them on Windows (`EPERM`), so
 * a plain `fs.rm` would leave a repository's folder behind. When the first attempt is refused
 * for permission, the tree is made writable and removal is tried once more.
 *
 * It never follows a symbolic link, so making things writable can never reach outside the folder.
 */
export async function removeTree(path: string): Promise<void> {
  try {
    await fs.rm(path, REMOVE_OPTIONS)
    return
  } catch (error) {
    if (!isPermissionError(error)) throw error
  }
  await makeWritable(path)
  await fs.rm(path, REMOVE_OPTIONS)
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'EACCES'
}

async function makeWritable(path: string): Promise<void> {
  let info
  try {
    info = await fs.lstat(path)
  } catch {
    return // already gone
  }
  if (info.isSymbolicLink()) return
  try {
    await fs.chmod(path, info.isDirectory() ? 0o700 : 0o600)
  } catch {
    // Not ours to change; the removal below will say what is in the way.
  }
  if (!info.isDirectory()) return
  for (const entry of await fs.readdir(path)) await makeWritable(join(path, entry))
}
