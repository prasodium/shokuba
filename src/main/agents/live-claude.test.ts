import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createServices } from '../bootstrap'
import { createLogger } from '../logging/logger'
import { toPlatformId } from '../platform'
import { createAgentServices } from './index'

/**
 * Opt-in: drives the *real* Claude Code CLI in a real PTY and checks that its hooks turn
 * into Shokuba events. It spends a few cents of the logged-in account's usage, so it only
 * runs when asked:   SHOKUBA_LIVE_CLAUDE=1 npm test -- live-claude
 */
const LIVE = process.env['SHOKUBA_LIVE_CLAUDE'] === '1'

/** Terminal text with escape sequences removed (cursor moves become spaces), for matching. */
function plain(text: string): string {
  /* eslint-disable no-control-regex -- matching terminal escape sequences is the point */
  return text
    .replace(/\u001b\[\d*[GC]/g, ' ')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*\u0007/g, '')
    .replace(/\s+/g, ' ')
  /* eslint-enable no-control-regex */
}

const SETUP_HINT =
  "Claude Code's first-run setup has not been completed on this machine (its terminal is showing " +
  'the welcome / login-method wizard). Finish it once — run `claude` in a terminal, or start a ' +
  'Claude Code employee in Shokuba and complete the setup in its terminal panel — then run this again.'

describe.skipIf(!LIVE)('live Claude Code', () => {
  it('reports a real turn through hooks', async () => {
    const platform = toPlatformId()
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'shokuba-live-')))
    const workdir = join(dir, 'work')
    mkdirSync(workdir)
    writeFileSync(join(workdir, 'hello.txt'), 'Kumquat is the first word of this file.\n')

    const services = createServices({
      dataDir: join(dir, 'data'),
      version: 'live',
      platform,
      logger: createLogger(() => {}),
    })
    const agents = await createAgentServices(services, {
      platform,
      env: process.env,
      home: homedir(),
    })

    let transcript = ''
    let trustAnswered = false
    const seenStates: string[] = []
    services.events.bus.on('agent.state.changed', (e) => {
      seenStates.push(`${e.payload.from}>${e.payload.to} [${e.source}] ${e.payload.reason ?? ''}`)
    })

    try {
      const employee = await agents.employees.create({
        name: 'Live',
        role: 'Tester',
        providerId: 'claude-code',
        workingDirectory: workdir,
        model: 'haiku',
      })

      agents.runtime.onTerminalData((_id, data) => {
        transcript += data
        // A brand-new folder asks whether to trust it; accept the default ("Yes, proceed").
        if (!trustAnswered && /trust/i.test(transcript)) {
          trustAnswered = true
          setTimeout(() => agents.runtime.write(employee.id, '\r'), 800)
        }
      })

      await agents.runtime.start(employee)

      // Wait until Claude Code has reported in (or give up and show what the terminal said).
      const waitFor = async (predicate: () => boolean, what: string, ms: number): Promise<void> => {
        const deadline = Date.now() + ms
        while (!predicate()) {
          if (Date.now() > deadline) {
            throw new Error(
              `Timed out waiting for ${what}.\nStates: ${seenStates.join(' | ')}\nTerminal tail:\n${transcript.slice(-1500)}`,
            )
          }
          await new Promise((r) => setTimeout(r, 200))
        }
      }

      await waitFor(() => transcript.length > 0, 'terminal output', 30_000)
      await new Promise((r) => setTimeout(r, 4_000))
      if (/Select login method|Choose the text style|Let's get started/i.test(plain(transcript))) {
        throw new Error(SETUP_HINT)
      }
      // Give the UI time to settle, then submit a prompt that needs no permission (reading a file in cwd).
      await new Promise((r) => setTimeout(r, 6_000))
      agents.runtime.write(employee.id, 'Read hello.txt and tell me its first word, nothing else.')
      await new Promise((r) => setTimeout(r, 500))
      agents.runtime.write(employee.id, '\r')

      await waitFor(
        () => services.events.log.list({ type: 'agent.turn.finished' }).length > 0,
        'the turn to finish',
        90_000,
      )

      const types = services.events.log.list({ limit: 500 }).map((e) => e.type)
      console.log('LIVE states:', seenStates)
      console.log('LIVE event types:', types.join(', '))

      expect(types).toContain('agent.ready')
      expect(types).toContain('agent.turn.started')
      expect(types).toContain('agent.tool.started')
      expect(types).toContain('agent.tool.finished')
      expect(types).toContain('agent.turn.finished')
      const tool = services.events.log.list({ type: 'agent.tool.started' })[0]
      expect(tool?.source).toBe('reported')
      expect(agents.views.snapshot([employee.id]).views[0]?.state).toBe('idle')

      await agents.runtime.stop(employee.id)
      expect(agents.runtime.isRunning(employee.id)).toBe(false)
      expect(services.events.log.list({ type: 'agent.stopped' })).toHaveLength(1)
    } finally {
      await agents.close()
      services.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)
})
