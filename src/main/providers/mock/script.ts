/**
 * The demo agent: a tiny Node program the mock provider runs in a real PTY. It prints a
 * prompt, and when given a task it reports a scripted sequence of work over the same hook
 * channel a real Claude Code uses (same JSON shapes), so the runtime, state tracker,
 * events and office all run their real code paths. Only the "agent" is fake.
 *
 * Ctrl+C mirrors Claude Code: it aborts a running turn without reporting anything, and quits
 * only from an idle prompt. Plain CommonJS so it runs under Node and Electron-as-Node alike.
 */
export const MOCK_AGENT_SCRIPT = String.raw`'use strict'
const url = process.env.SHOKUBA_HOOK_URL
const token = process.env.SHOKUBA_HOOK_TOKEN
const stepMs = Number(process.env.SHOKUBA_MOCK_STEP_MS || 900)
const cwd = process.cwd()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const say = (text) => process.stdout.write(text + '\r\n')

async function report(payload) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify(Object.assign({ session_id: 'demo', cwd: cwd }, payload)),
    })
  } catch (error) {
    say('[demo] could not report: ' + error.message)
  }
}

const plan = [
  { tool: 'Read', input: { file_path: cwd + '/README.md' }, text: 'Reading the README' },
  { tool: 'Grep', input: { pattern: 'TODO' }, text: 'Looking for TODOs' },
  { tool: 'Edit', input: { file_path: cwd + '/src/index.ts' }, text: 'Editing src/index.ts' },
  { tool: 'Bash', input: { command: 'npm test' }, text: 'Running the tests' },
]

let busy = false
let aborted = false
async function runTurn() {
  busy = true
  aborted = false
  await report({ hook_event_name: 'UserPromptSubmit', prompt: '(demo)' })
  say('[demo] on it...')
  await sleep(stepMs)
  for (const step of plan) {
    if (aborted) break
    const id = 'toolu_' + Math.random().toString(36).slice(2, 10)
    say('[demo] ' + step.text)
    await report({ hook_event_name: 'PreToolUse', tool_name: step.tool, tool_input: step.input, tool_use_id: id })
    await sleep(stepMs)
    if (aborted) break
    await report({ hook_event_name: 'PostToolUse', tool_name: step.tool, tool_input: step.input, tool_use_id: id, duration_ms: stepMs })
    await sleep(stepMs / 3)
  }
  if (aborted) {
    // Like Claude Code, an interrupted turn reports nothing at all.
    say('[demo] interrupted.')
  } else {
    await report({ hook_event_name: 'Stop', last_assistant_message: 'Done (demo).' })
    say('[demo] done.')
  }
  busy = false
  aborted = false
  process.stdout.write('> ')
}

async function main() {
  say('Shokuba demo agent (simulated - no AI is running). Type anything and press Enter.')
  await report({ hook_event_name: 'SessionStart', start_reason: 'startup' })
  process.stdout.write('> ')
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('data', (chunk) => {
    for (const char of String(chunk)) {
      if (char.charCodeAt(0) === 3) {
        // Ctrl+C stops the current turn; at an idle prompt it quits.
        if (busy) {
          aborted = true
        } else {
          say('')
          say('[demo] bye')
          process.exit(0)
        }
      } else if (char === '\r' || char === '\n') {
        say('')
        if (!busy) void runTurn()
      } else if (!busy) {
        process.stdout.write(char)
      }
    }
  })
}
void main()
`
