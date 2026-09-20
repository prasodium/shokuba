#!/usr/bin/env node
// A stand-in for the GitHub command-line tool, for tests and for recording the demo. It never
// touches the network: it answers from a script of canned responses.
//
// Its first argument is the path of a JSON file that says how to behave (it is a file, not an
// environment variable, because the real tool is run with a stripped-down environment):
//   { "login": "octocat" | null,          who is signed in (null = signed out)
//     "issues": [ {...GitHub issue objects...} ],
//     "fail": { "status": 404 },          answer every API request with this HTTP error
//     "log": "/path/to/file" }            append every request (arguments and stdin) to this file
// Special commands: `--version`, `env-dump` (prints the variables it was given), `sleep`
// (never answers), `flood` (prints far too much), `exit <code> <message>`.
import { appendFileSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { setInterval } from 'node:timers'

const [configPath, ...args] = process.argv.slice(2)
const script = configPath ? JSON.parse(readFileSync(configPath, 'utf8')) : {}

function stdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

if (script.log) {
  appendFileSync(script.log, JSON.stringify({ args, input: stdin() }) + '\n')
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

if (args[0] === '--version') {
  process.stdout.write('gh version 2.99.0 (2026-01-01)\nhttps://github.com/cli/cli/releases\n')
  process.exit(0)
}
if (args[0] === 'env-dump') {
  process.stdout.write(JSON.stringify(process.env))
  process.exit(0)
}
if (args[0] === 'sleep') {
  setInterval(() => undefined, 1000)
} else if (args[0] === 'flood') {
  const chunk = 'x'.repeat(65536)
  for (let i = 0; i < 200; i += 1) process.stdout.write(chunk)
  process.exit(0)
} else if (args[0] === 'exit') {
  fail(args[2] ?? 'failed', Number(args[1] ?? 1))
} else if (args[0] === 'api') {
  if (script.login === null || script.login === undefined) {
    fail(
      'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.',
      4,
    )
  }
  if (script.fail) fail(`gh: Request failed (HTTP ${script.fail.status})`)
  // Like the real tool: these flags each take a value, and the one thing left over is the path.
  const takesValue = new Set([
    '--hostname',
    '-H',
    '--header',
    '-X',
    '--method',
    '--jq',
    '-q',
    '-f',
    '-F',
    '--input',
  ])
  const rest = args.slice(1)
  let path
  let jq
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (arg === '--jq' || arg === '-q') jq = rest[i + 1]
    if (takesValue.has(arg)) i += 1
    else if (!arg.startsWith('-') && path === undefined) path = arg
  }
  const respond = (value) => process.stdout.write(JSON.stringify(value))

  if (path === 'user') {
    // With --jq the real tool prints a string bare, without quotes.
    if (jq) process.stdout.write(`${script.login}\n`)
    else respond({ login: script.login })
    process.exit(0)
  }
  const list = /^repos\/([^/]+)\/([^/]+)\/issues$/.exec(path ?? '')
  const one = /^repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(path ?? '')
  if (list) {
    respond(
      (script.issues ?? [])
        .filter((issue) => !issue.pull_request)
        .map((issue) => ({
          number: issue.number,
          title: issue.title,
          state: issue.state,
          user: issue.user?.login ?? null,
          labels: (issue.labels ?? []).map((l) => l.name),
          comments: issue.comments ?? 0,
          updated_at: issue.updated_at,
        })),
    )
    process.exit(0)
  }
  if (one) {
    const issue = (script.issues ?? []).find((i) => String(i.number) === one[3])
    if (!issue) fail('gh: Not Found (HTTP 404)')
    respond({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      user: issue.user?.login ?? null,
      labels: (issue.labels ?? []).map((l) => l.name),
      comments: issue.comments ?? 0,
      updated_at: issue.updated_at,
      body: issue.body ?? null,
      is_pull_request: Boolean(issue.pull_request),
    })
    process.exit(0)
  }
  fail('gh: Not Found (HTTP 404)')
} else {
  fail(`unknown command: ${args.join(' ')}`)
}
