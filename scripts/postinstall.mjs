// Shokuba postinstall.
//
// node-pty ships a `spawn-helper` binary that it execs on macOS/Linux to set up the
// pseudo-terminal. npm extracts the prebuilt copy without the execute bit, so every
// PTY spawn fails with "posix_spawnp failed." until it is restored.
//
// No-op on Windows (ConPTY does not use spawn-helper) and when node-pty is absent.
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

if (process.platform === 'win32') process.exit(0)

const require = createRequire(import.meta.url)

let ptyRoot
try {
  ptyRoot = dirname(require.resolve('node-pty/package.json'))
} catch {
  process.exit(0)
}

const candidates = [join(ptyRoot, 'build', 'Release', 'spawn-helper')]
const prebuilds = join(ptyRoot, 'prebuilds')
if (existsSync(prebuilds)) {
  for (const entry of readdirSync(prebuilds)) {
    candidates.push(join(prebuilds, entry, 'spawn-helper'))
  }
}

let fixed = 0
for (const file of candidates) {
  if (!existsSync(file)) continue
  const mode = statSync(file).mode
  if ((mode & 0o111) === 0o111) continue
  chmodSync(file, mode | 0o755)
  fixed += 1
}

if (fixed > 0)
  console.log(`[shokuba] restored execute bit on ${fixed} node-pty spawn-helper file(s)`)
