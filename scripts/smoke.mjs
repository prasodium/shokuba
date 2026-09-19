// Runs the built app in smoke-test mode inside real Electron and prints a readable report.
// Exits non-zero when any check fails, so CI can gate on it.
//
// Usage: npm run smoke   (builds first)
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronBinary = require('electron') // path to the Electron executable

// Some parents (other Electron apps' terminals) leak this; it turns Electron into plain Node.
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const result = spawnSync(electronBinary, ['.', '--shokuba-smoke-test'], {
  env,
  encoding: 'utf8',
  timeout: 90_000,
})

if (result.error) {
  console.error(`Could not launch Electron: ${result.error.message}`)
  process.exit(1)
}

const line = result.stdout.split('\n').find((l) => l.startsWith('SHOKUBA_SMOKE '))
if (!line) {
  console.error('Smoke test produced no report.')
  console.error(result.stdout)
  console.error(result.stderr)
  process.exit(1)
}

const report = JSON.parse(line.slice('SHOKUBA_SMOKE '.length))
const { runtime } = report
console.log(
  `Electron ${runtime.electron} / Node ${runtime.node} (ABI ${runtime.abi}) on ${runtime.platform}-${runtime.arch}`,
)
for (const [name, check] of Object.entries(report.checks)) {
  console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${name}  -  ${check.detail}`)
}
console.log(report.ok ? '\nSmoke test passed.' : '\nSmoke test FAILED.')
process.exit(report.ok ? 0 : 1)
