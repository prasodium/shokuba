import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { createServices } from './bootstrap'
import { MIGRATIONS } from './database/migrations'
import { createLogger, describeError } from './logging/logger'
import { findExecutable, safeChildEnv, shellCommand, toPlatformId } from './platform'

export interface SmokeCheck {
  ok: boolean
  detail: string
}

export interface SmokeReport {
  ok: boolean
  runtime: { electron: string; node: string; abi: string; platform: string; arch: string }
  checks: Record<string, SmokeCheck>
}

const PTY_TIMEOUT_MS = 15_000

/**
 * Runs inside the real Electron runtime (`--shokuba-smoke-test`) and exercises what unit
 * tests cannot: the native modules under Electron's ABI, a real PTY, and a database
 * surviving a restart. Exits non-zero if anything fails, so CI can gate on it.
 */
export async function runSmokeTest(): Promise<SmokeReport> {
  const platform = toPlatformId()
  const checks: Record<string, SmokeCheck> = {}
  const dir = mkdtempSync(join(tmpdir(), 'shokuba-smoke-'))
  const logger = createLogger(() => {})

  const run = async (name: string, fn: () => Promise<string> | string): Promise<void> => {
    try {
      checks[name] = { ok: true, detail: await fn() }
    } catch (error) {
      checks[name] = { ok: false, detail: describeError(error).message }
    }
  }

  try {
    await run('sqlite-and-migrations', () => {
      const services = createServices({ dataDir: dir, version: 'smoke', platform, logger })
      try {
        if (services.schemaVersion !== MIGRATIONS.length) throw new Error('schema version mismatch')
        services.events.publish({
          type: 'agent.ready',
          source: 'system',
          payload: { employeeId: 'smoke' },
        })
        return `schema v${services.schemaVersion}, ${services.events.log.count()} events`
      } finally {
        services.close()
      }
    })

    await run('history-survives-restart', () => {
      const services = createServices({ dataDir: dir, version: 'smoke', platform, logger })
      try {
        const ready = services.events.log.list({ type: 'agent.ready' })
        if (ready.length !== 1)
          throw new Error(`expected 1 agent.ready after restart, found ${ready.length}`)
        return 'event written before restart was read back'
      } finally {
        services.close()
      }
    })

    await run('pty-spawn', () => spawnAndRead(platform, dir))

    await run('locate-git', async () => {
      const found = await findExecutable('git', { platform, env: process.env, home: homedir() })
      if (!found) throw new Error('git not found on PATH or in common install locations')
      return found
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  return {
    ok: Object.values(checks).every((check) => check.ok),
    runtime: {
      electron: process.versions.electron ?? 'n/a',
      node: process.versions.node,
      abi: process.versions.modules,
      platform,
      arch: process.arch,
    },
    checks,
  }
}

/**
 * Run a command through the platform's default shell in a real PTY and read back what it
 * prints. A shell is a genuine console program, like the agent CLIs this will host, and
 * this also exercises `shellCommand()` on whatever OS the test runs on.
 */
function spawnAndRead(platform: ReturnType<typeof toPlatformId>, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const shell = shellCommand(platform, process.env, 'echo pty-ok')
    const via = `${shell.file} ${shell.args.join(' ')}`
    const child = pty.spawn(shell.file, [...shell.args], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: safeChildEnv(platform, process.env),
    })

    let output = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(
        new Error(
          `PTY did not exit within ${PTY_TIMEOUT_MS}ms via [${via}] (output so far: "${output.trim()}")`,
        ),
      )
    }, PTY_TIMEOUT_MS)

    child.onData((data) => {
      output += data
    })
    child.onExit(({ exitCode }) => {
      clearTimeout(timer)
      if (exitCode === 0 && output.includes('pty-ok'))
        resolve(`pid ${child.pid} exited 0 via ${shell.file}, output "${output.trim()}"`)
      else reject(new Error(`exit ${exitCode} via [${via}], output "${output.trim()}"`))
    })
  })
}
