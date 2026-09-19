import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTree, toPlatformId } from '../platform'
import { cleanOutput, MAX_OUTPUT_BYTES, runStep, type StepSpec } from './runner'

let dir: string
const platform = toPlatformId()
const options = { platform, env: process.env, graceMs: 300 }

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'shokuba-runner-')))
})

afterEach(async () => {
  delete process.env['SHOKUBA_TEST_SECRET']
  await removeTree(dir)
})

/** `node -e "<code>"`: the same command line on every shell, as long as the code has no double quotes. */
const node = (code: string): string => `node -e "${code}"`
const spec = (command: string, timeoutMs = 20_000): StepSpec => ({ command, cwd: dir, timeoutMs })
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('running a step', () => {
  it('passes when the command exits 0, and keeps what it printed', async () => {
    const outcome = await runStep(spec(node("console.log('hello from the check')")), options)
    expect(outcome.state).toBe('passed')
    expect(outcome.exitCode).toBe(0)
    expect(outcome.output).toContain('hello from the check')
    expect(outcome.truncated).toBe(false)
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('fails when it exits with anything else, keeping the exit code and the error output', async () => {
    const outcome = await runStep(spec(node("console.error('boom'); process.exit(3)")), options)
    expect(outcome).toMatchObject({ state: 'failed', exitCode: 3 })
    expect(outcome.output).toContain('boom')
  })

  it('fails for a command that does not exist, and says what the shell said', async () => {
    const outcome = await runStep(spec('shokuba-no-such-command-xyz'), options)
    expect(outcome.state).toBe('failed')
    expect(outcome.exitCode).not.toBe(0)
    expect(outcome.output.length).toBeGreaterThan(0)
  })

  it('understands a command line with more than one command in it', async () => {
    const outcome = await runStep(
      spec(`${node("console.log('one')")} && ${node("console.log('two')")}`),
      options,
    )
    expect(outcome.state).toBe('passed')
    expect(outcome.output).toContain('one')
    expect(outcome.output).toContain('two')
  })

  it('runs in the folder it was given', async () => {
    const folder = join(dir, 'work')
    mkdirSync(folder)
    const outcome = await runStep(
      { ...spec(node('console.log(process.cwd())')), cwd: folder },
      options,
    )
    expect(realpathSync.native(outcome.output.trim())).toBe(realpathSync.native(folder))
  })

  it('reports a folder that is not there as an error, without running anything', async () => {
    const outcome = await runStep(
      { ...spec(node("console.log('x')")), cwd: join(dir, 'missing') },
      options,
    )
    expect(outcome.state).toBe('error')
    expect(outcome.exitCode).toBeNull()
    expect(outcome.output).toMatch(/Could not/)
  })
})

describe('what the command is given', () => {
  it('a clean environment: a secret in Shokuba’s own is not passed on', async () => {
    process.env['SHOKUBA_TEST_SECRET'] = 'do-not-leak'
    const outcome = await runStep(
      spec(node("console.log(process.env.SHOKUBA_TEST_SECRET || 'absent')")),
      {
        ...options,
        env: process.env,
      },
    )
    expect(outcome.output.trim()).toBe('absent')
  })

  it('the ones tools need to behave in a script: no interactive mode, no colour', async () => {
    const outcome = await runStep(
      spec(node('console.log([process.env.CI, process.env.NO_COLOR].join())')),
      options,
    )
    expect(outcome.output.trim()).toBe('true,1')
  })

  it('no input: a command that reads stdin sees the end at once instead of waiting', async () => {
    const outcome = await runStep(
      spec(node("process.stdin.on('end', () => console.log('eof')).resume()"), 10_000),
      options,
    )
    expect(outcome.state).toBe('passed')
    expect(outcome.output).toContain('eof')
  })
})

describe('stopping a step', () => {
  it('times out a command that will not end, and says so', async () => {
    const started = Date.now()
    const outcome = await runStep(spec(node('setInterval(() => {}, 1000)'), 500), options)
    expect(outcome.state).toBe('timeout')
    expect(outcome.exitCode).toBeNull()
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  it('can be cancelled', async () => {
    const controller = new AbortController()
    const running = runStep(spec(node('setInterval(() => {}, 1000)')), options, controller.signal)
    await sleep(300)
    controller.abort()
    const outcome = await running
    expect(outcome.state).toBe('cancelled')
  })

  it('is cancelled at once if it was already told to stop', async () => {
    const controller = new AbortController()
    controller.abort()
    const outcome = await runStep(
      spec(node('setInterval(() => {}, 1000)')),
      options,
      controller.signal,
    )
    expect(outcome.state).toBe('cancelled')
  })

  it('stops everything the command started, not only the command itself', async () => {
    const marker = join(dir, 'marker.txt')
    const script = join(dir, 'parent.cjs')
    // The parent starts a child that writes to a file forever, then waits forever.
    writeFileSync(
      script,
      [
        "const { spawn } = require('child_process')",
        `const marker = ${JSON.stringify(marker)}`,
        "spawn(process.execPath, ['-e', 'setInterval(() => require(\"fs\").appendFileSync(process.argv[1], \"x\"), 40)', marker], { stdio: 'ignore' })",
        'setInterval(() => {}, 1000)',
      ].join('\n'),
    )
    const outcome = await runStep(spec(`node "${script}"`, 1_200), options)
    expect(outcome.state).toBe('timeout')

    // Once it has been stopped, the child must not still be writing.
    await sleep(500)
    const sizeThen = existsSync(marker) ? statSync(marker).size : 0
    expect(sizeThen).toBeGreaterThan(0) // it did start, so the test means something
    await sleep(500)
    const sizeNow = statSync(marker).size
    expect(sizeNow).toBe(sizeThen)
  })
})

describe('the output that is kept', () => {
  it('is cut to the end, where a failure is reported, and says it was cut', async () => {
    const outcome = await runStep(
      spec(node("for (let i = 1; i <= 20000; i++) console.log('line ' + i)")),
      options,
    )
    expect(outcome.truncated).toBe(true)
    expect(Buffer.byteLength(outcome.output)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES + 64)
    expect(outcome.output).toContain('line 20000')
    expect(outcome.output).not.toContain('line 1\n')
  })

  it('leaves out terminal colour codes and turns progress redraws into lines', async () => {
    const outcome = await runStep(
      spec(
        node(
          "process.stdout.write(String.fromCharCode(27) + '[31mred' + String.fromCharCode(27) + '[0m done\\r50%\\r100%\\n')",
        ),
      ),
      options,
    )
    expect(outcome.output).toBe('red done\n50%\n100%\n')
  })

  it('has secrets redacted before it is kept', async () => {
    // Built at run time: a token-shaped literal in the source would itself be a secret in the repo.
    const token = 'gh' + 'p_' + 'a'.repeat(36)
    const outcome = await runStep(spec(node(`console.log('token is ${token}')`)), options)
    expect(outcome.output).not.toContain(token)
    expect(outcome.output).toContain('[REDACTED:github-token]')
  })
})

describe('cleanOutput', () => {
  it('drops control characters other than newlines and tabs', () => {
    const bell = String.fromCharCode(7)
    expect(cleanOutput(`a${bell}b\tc\nd`)).toBe('ab\tc\nd')
  })

  it('removes window-title and link sequences', () => {
    const esc = String.fromCharCode(27)
    const bel = String.fromCharCode(7)
    expect(cleanOutput(`${esc}]0;my title${bel}visible`)).toBe('visible')
  })

  it('normalises Windows line endings', () => {
    expect(cleanOutput('one\r\ntwo\r\n')).toBe('one\ntwo\n')
  })
})

describe('the files it works on', () => {
  it('can read and write in its folder like any command', async () => {
    const outcome = await runStep(
      spec(node("require('fs').writeFileSync('made.txt', 'by the check')")),
      options,
    )
    expect(outcome.state).toBe('passed')
    expect(readFileSync(join(dir, 'made.txt'), 'utf8')).toBe('by the check')
  })
})
