/**
 * The demo agent: a tiny Node program the mock provider runs in a real PTY. It prints a
 * prompt, and when given a task it reports a scripted sequence of work over the same hook
 * channel a real Claude Code uses (same JSON shapes), and talks to Shokuba's MCP tools the
 * way Claude Code does (initialize, then tools/call). So the runtime, state tracker, events,
 * dispatcher, router and office all run their real code paths. Only the "agent" is fake.
 *
 * Like Claude Code it understands a bracketed paste (a pasted briefing or message is one
 * input, and the Enter after it starts the work), carries on when Shokuba answers the report
 * that ends a turn with a continuation, and treats Ctrl+C as aborting a running turn without
 * reporting anything (quitting only from an idle prompt).
 *
 * With SHOKUBA_MOCK_CHATTY=1 it answers every message it receives, which lets a test start a
 * runaway exchange between two agents. Plain CommonJS so it runs under Node and
 * Electron-as-Node alike.
 */
export const MOCK_AGENT_SCRIPT = String.raw`'use strict'
const url = process.env.SHOKUBA_HOOK_URL
const mcpUrl = process.env.SHOKUBA_MCP_URL
const token = process.env.SHOKUBA_HOOK_TOKEN
const stepMs = Number(process.env.SHOKUBA_MOCK_STEP_MS || 900)
const chatty = process.env.SHOKUBA_MOCK_CHATTY === '1'
const cwd = process.cwd()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const say = (text) => process.stdout.write(text + '\r\n')
const START = '\x1b[200~'
const END = '\x1b[201~'

// Sends a hook report and returns what Shokuba answered (a Stop may carry a continuation).
async function report(payload) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify(Object.assign({ session_id: 'demo', cwd: cwd }, payload)),
    })
    return await res.json()
  } catch (error) {
    say('[demo] could not report: ' + error.message)
    return {}
  }
}

// --- a minimal MCP client, the same handshake Claude Code performs ---
const mcpHeaders = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  authorization: 'Bearer ' + token,
}
let rpcId = 0
let mcpReady = false
async function rpc(method, params) {
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: method, params: params }),
  })
  const body = await res.json()
  if (body.error) throw new Error(body.error.message)
  return body.result
}
async function callTool(name, args) {
  if (!mcpReady) {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'shokuba-demo-agent', version: '1' } })
    await fetch(mcpUrl, { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
    mcpReady = true
  }
  const result = await rpc('tools/call', { name: name, arguments: args })
  return result.content.map((part) => part.text).join('\n')
}

// Use a Shokuba tool the way a model would: the hooks report it, then the call is made.
async function useShokubaTool(name, args) {
  const id = 'toolu_' + Math.random().toString(36).slice(2, 10)
  const full = 'mcp__shokuba__' + name
  await report({ hook_event_name: 'PreToolUse', tool_name: full, tool_input: args, tool_use_id: id })
  let text
  try {
    text = await callTool(name, args)
  } catch (error) {
    text = 'error: ' + error.message
  }
  await report({ hook_event_name: 'PostToolUse', tool_name: full, tool_input: args, tool_use_id: id, duration_ms: 5 })
  return text
}

const plan = [
  { tool: 'Read', input: { file_path: cwd + '/README.md' }, text: 'Reading the README' },
  { tool: 'Grep', input: { pattern: 'TODO' }, text: 'Looking for TODOs' },
  { tool: 'Edit', input: { file_path: cwd + '/src/index.ts' }, text: 'Editing src/index.ts' },
  { tool: 'Bash', input: { command: 'npm test' }, text: 'Running the tests' },
]

let busy = false
let aborted = false

// What the agent does with a message from a teammate (or the person).
async function handleMessage(text) {
  say('[demo] received a message')
  await sleep(stepMs)
  if (!chatty) return
  const from = /^From: (.+?) \(/m.exec(text)
  let to = from ? from[1] : null
  if (!to) {
    // A message from the person: start a conversation with the first teammate.
    const team = await useShokubaTool('list_teammates', {})
    const first = /^- (.+?) \(/m.exec(team)
    to = first ? first[1] : null
  }
  if (!to) return
  say('[demo] replying to ' + to)
  const answer = await useShokubaTool('send_message', { to: to, subject: 'ping', body: 'hello from the demo agent' })
  say('[demo] ' + answer)
}

// A turn ends with a Stop report; Shokuba may answer it with a message to carry on with.
async function endTurn() {
  for (;;) {
    const reply = await report({ hook_event_name: 'Stop', last_assistant_message: 'Done (demo).' })
    if (reply && reply.decision === 'block' && reply.reason) {
      // Carrying on with what Shokuba sent: no new prompt is submitted, just more work.
      await handleMessage(String(reply.reason))
      continue
    }
    return
  }
}

async function runTurn(input) {
  busy = true
  aborted = false
  await report({ hook_event_name: 'UserPromptSubmit', prompt: '(demo)' })
  if (input.startsWith('[Shokuba message]')) {
    await handleMessage(input)
  } else {
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
    if (!aborted && mcpUrl) {
      // If Shokuba handed us a task, say we are done with it, as a real agent would.
      const current = await useShokubaTool('get_current_task', {})
      if (!current.startsWith('You have no task')) {
        say('[demo] submitting the task')
        const answer = await useShokubaTool('submit_task', {
          summary: 'Demo work complete (simulated): read the README, edited src/index.ts, ran the tests.',
        })
        say('[demo] ' + answer)
      }
    }
  }
  if (aborted) {
    // Like Claude Code, an interrupted turn reports nothing at all.
    say('[demo] interrupted.')
  } else {
    await endTurn()
    say('[demo] done.')
  }
  busy = false
  aborted = false
  process.stdout.write('> ')
}

async function main() {
  // Start listening before announcing readiness: once Shokuba sees the agent report in, input
  // is safe to send. (Console input written earlier can be lost, notably on Windows.)
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.resume()
  let pasting = false
  let pasted = ''
  let typedText = ''
  let carry = ''
  process.stdin.on('data', (chunk) => {
    const text = carry + String(chunk)
    carry = ''
    for (let i = 0; i < text.length; i++) {
      const char = text[i]
      if (char === '\x1b') {
        const rest = text.slice(i)
        if (rest.startsWith(START)) {
          pasting = true
          pasted = ''
          i += START.length - 1
        } else if (rest.startsWith(END)) {
          pasting = false
          i += END.length - 1
        } else if (rest.length < START.length && (START.startsWith(rest) || END.startsWith(rest))) {
          carry = rest
          break
        }
        continue
      }
      if (pasting) {
        pasted += char
        continue
      }
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
        if (!busy) {
          const input = pasted || typedText
          pasted = ''
          typedText = ''
          void runTurn(input)
        }
      } else if (!busy) {
        typedText += char
        process.stdout.write(char)
      }
    }
  })
  say('Shokuba demo agent (simulated - no AI is running). Type anything and press Enter.')
  process.stdout.write('> ')
  await report({ hook_event_name: 'SessionStart', start_reason: 'startup' })
}
void main()
`
