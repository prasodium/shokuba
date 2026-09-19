// Runs the built app in smoke-test mode inside real Electron and prints a readable report.
// Exits non-zero when any check fails, so CI can gate on it.
//
// Usage: npm run smoke   (builds first)
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { clearTimeout, setTimeout } from 'node:timers'

const require = createRequire(import.meta.url)
const electronBinary = require('electron') // path to the Electron executable

// Some parents (other Electron apps' terminals) leak this; it turns Electron into plain Node.
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// Extra Electron flags for environments that need them. CI on Linux sets `--no-sandbox`
// because GitHub's runners do not install Electron's chrome-sandbox helper as set-uid root.
// The smoke test opens no window and loads no untrusted content.
const extraArgs = (process.env.SHOKUBA_ELECTRON_ARGS ?? '').split(/\s+/).filter(Boolean)

// The whole run, not one check. Slow machines (a Windows CI runner opening real terminals)
// need well over a minute; a real hang still ends, and says which check it was in.
const LIMIT_MS = 240_000

const child = spawn(electronBinary, ['.', ...extraArgs, '--shokuba-smoke-test'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
let running = null
const timings = []
child.stdout.setEncoding('utf8').on('data', (chunk) => {
  stdout += chunk
  for (const line of chunk.split('\n')) {
    const start = /^SHOKUBA_SMOKE_START (\S+)/.exec(line)
    if (start) running = start[1]
    const done = /^SHOKUBA_SMOKE_DONE (\S+) (\S+) (\d+)ms/.exec(line)
    if (done) {
      timings.push({ name: done[1], ms: Number(done[3]) })
      running = null
    }
  }
})
child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))

const timer = setTimeout(() => {
  console.error(`Smoke test timed out after ${LIMIT_MS / 1000}s.`)
  console.error(running ? `It was still running: ${running}` : 'No check was running.')
  report()
  child.kill()
  process.exit(1)
}, LIMIT_MS)

child.on('error', (error) => {
  clearTimeout(timer)
  console.error(`Could not launch Electron: ${error.message}`)
  process.exit(1)
})

child.on('close', () => {
  clearTimeout(timer)
  const line = stdout.split('\n').find((l) => l.startsWith('SHOKUBA_SMOKE '))
  if (!line) {
    console.error('Smoke test produced no report.')
    console.error(stdout)
    console.error(stderr)
    process.exit(1)
  }

  const result = JSON.parse(line.slice('SHOKUBA_SMOKE '.length))
  const { runtime } = result
  console.log(
    `Electron ${runtime.electron} / Node ${runtime.node} (ABI ${runtime.abi}) on ${runtime.platform}-${runtime.arch}`,
  )
  for (const [name, check] of Object.entries(result.checks)) {
    console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${name}  -  ${check.detail}`)
  }
  report()
  console.log(result.ok ? '\nSmoke test passed.' : '\nSmoke test FAILED.')
  process.exit(result.ok ? 0 : 1)
})

/** How long each check took, so a slow one is easy to see. */
function report() {
  if (timings.length === 0) return
  console.log(
    '  timings: ' + timings.map((t) => `${t.name} ${(t.ms / 1000).toFixed(1)}s`).join(', '),
  )
}
