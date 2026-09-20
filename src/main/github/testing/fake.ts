import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** Where the stand-in for `gh` lives (see `fake-gh.mjs` for what it does). */
export const FAKE_GH = path.join(__dirname, 'fake-gh.mjs')

export interface FakeIssue {
  number: number
  title: string
  state: 'open' | 'closed'
  user?: { login: string } | null
  labels?: Array<{ name: string }>
  comments?: number
  updated_at: string
  body?: string | null
  pull_request?: object
}

export interface FakeGhScript {
  /** Who is signed in; `null` for nobody. */
  login: string | null
  issues?: FakeIssue[]
  /** Answer every request with this HTTP error. */
  fail?: { status: number }
}

export interface FakeGh {
  /** Pass these to `GhCli` to run the stand-in through Node. */
  executable: string
  prefixArgs: string[]
  /** Every request it has been asked, in order. */
  requests(): Array<{ args: string[]; input: string }>
  cleanup(): void
}

/** A stand-in for `gh` that answers from `script` and never touches the network. */
export function fakeGh(script: FakeGhScript): FakeGh {
  const dir = mkdtempSync(path.join(tmpdir(), 'shokuba-fake-gh-'))
  const config = path.join(dir, 'config.json')
  const log = path.join(dir, 'log')
  writeFileSync(config, JSON.stringify({ ...script, log }))
  return {
    executable: process.execPath,
    prefixArgs: [FAKE_GH, config],
    requests() {
      try {
        return readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as { args: string[]; input: string })
      } catch {
        return []
      }
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
