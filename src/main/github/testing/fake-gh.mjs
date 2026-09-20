#!/usr/bin/env node
// A stand-in for the GitHub command-line tool, for tests and for recording the demo. It never
// touches the network: it answers from a script of canned responses.
//
// Its first argument is the path of a JSON file that says how to behave (it is a file, not an
// environment variable, because the real tool is run with a stripped-down environment):
//   { "login": "octocat" | null,          who is signed in (null = signed out)
//     "issues": [ {...GitHub issue objects...} ],
//     "pull": { "state": "open", "merged": false, "draft": true, "head": "<40 hex>" },
//     "checkRuns": [ {"id": 1, "name": "build", "status": "completed", "conclusion": "failure"} ],
//     "statuses": [ {"context": "ci/x", "state": "success"} ],
//     "checkOutputs": { "1": {"name": "build", "conclusion": "failure", "title": "...", "summary": "..."} },
//     "reviews": [ {"id": 5, "user": {"login": "ada"}, "state": "CHANGES_REQUESTED", "body": "..."} ],
//     "reviewComments": { "5": [ {"path": "a.ts", "line": 3, "body": "..."} ] },
//     "defaultBranch": "main",            the repository's default branch
//     "openPulls": [ {"number": 3} ],     open pull requests, whatever branch is asked about
//     "nextPull": 7,                      the number a new pull request gets
//     "pullError": { "status": 422, "message": "..." },   refuse to open a pull request
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
  const method = rest[rest.indexOf('-X') + 1] ?? 'GET'

  if (path === 'user') {
    // With --jq the real tool prints a string bare, without quotes.
    if (jq) process.stdout.write(`${script.login}\n`)
    else respond({ login: script.login })
    process.exit(0)
  }
  if (/^repos\/[^/]+\/[^/]+$/.test(path ?? '')) {
    // With --jq the real tool prints a string bare, without quotes.
    process.stdout.write(`${script.defaultBranch ?? 'main'}\n`)
    process.exit(0)
  }
  if (/^repos\/[^/]+\/[^/]+\/pulls$/.test(path ?? '')) {
    if (method === 'POST') {
      if (script.pullError) {
        // The real tool prints the error body on standard output and its own words on standard error.
        process.stdout.write(
          JSON.stringify({
            message: 'Validation Failed',
            errors: [{ message: script.pullError.message }],
          }),
        )
        fail(`gh: Validation Failed (HTTP ${script.pullError.status})`)
      }
      respond({ number: script.nextPull ?? 7 })
      process.exit(0)
    }
    respond(
      (script.openPulls ?? []).map((pull) => ({ number: pull.number, draft: pull.draft === true })),
    )
    process.exit(0)
  }
  // A pull request that is being followed: its state, its checks and its reviews.
  const pullOne = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(path ?? '')
  if (pullOne) {
    const pull = script.pull ?? {}
    respond({
      state: pull.state ?? 'open',
      merged: pull.merged === true,
      draft: pull.draft === true,
      head: pull.head ?? 'a'.repeat(40),
    })
    process.exit(0)
  }
  if (/^repos\/[^/]+\/[^/]+\/commits\/[0-9a-f]+\/check-runs$/.test(path ?? '')) {
    respond(script.checkRuns ?? [])
    process.exit(0)
  }
  if (/^repos\/[^/]+\/[^/]+\/commits\/[0-9a-f]+\/status$/.test(path ?? '')) {
    respond(script.statuses ?? [])
    process.exit(0)
  }
  const checkRun = /^repos\/[^/]+\/[^/]+\/check-runs\/(\d+)$/.exec(path ?? '')
  if (checkRun) {
    const found = (script.checkOutputs ?? {})[checkRun[1]]
    if (!found) fail('gh: Not Found (HTTP 404)')
    respond({
      name: found.name,
      conclusion: found.conclusion,
      title: found.title,
      summary: found.summary,
    })
    process.exit(0)
  }
  if (/^repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews$/.test(path ?? '')) {
    respond(
      (script.reviews ?? []).map((r) => ({
        id: r.id,
        user: r.user?.login ?? null,
        state: r.state,
        body: r.body ?? null,
      })),
    )
    process.exit(0)
  }
  const reviewComments = /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews\/(\d+)\/comments$/.exec(
    path ?? '',
  )
  if (reviewComments) {
    respond((script.reviewComments ?? {})[reviewComments[1]] ?? [])
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
