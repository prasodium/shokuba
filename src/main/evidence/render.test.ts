import { describe, expect, it } from 'vitest'
import { renderPack, renderReport } from './render'
import type { CheckRunRecord, EvidencePack, ReviewRecord } from './types'

const COMMIT = 'a'.repeat(40)
const ESC = String.fromCharCode(0x1b)

const pack = (patch: Partial<EvidencePack> = {}): EvidencePack => ({
  schemaVersion: 1,
  generatedAt: '2026-01-02T03:04:05.000Z',
  shokubaVersion: '0.0.1',
  mission: { id: 'm1', title: 'Ship login', description: '', status: 'completed' },
  task: {
    id: 't1',
    title: 'Build the login form',
    description: 'Validate the email.',
    status: 'done',
    priority: 'normal',
    attempts: 2,
    assignee: { id: 'ren', name: 'Ren', role: 'Engineer' },
    dependsOn: [],
    createdAt: 'c',
    startedAt: 's',
    submittedAt: 'u',
    completedAt: 'd',
    agentSummary: 'Did it.',
    blockedReason: null,
    lastFeedback: null,
  },
  outcome: {
    accepted: true,
    acceptedAt: '2026-01-02T00:00:00.000Z',
    acceptedBy: 'person',
    sentBack: 1,
  },
  work: {
    isolated: true,
    problem: null,
    state: 'merged',
    project: 'my-project',
    branch: 'shokuba/task/t1',
    missionBranch: 'shokuba/mission/m1',
    baseCommit: 'b'.repeat(40),
    finalCommit: COMMIT,
    mergeCommit: 'c'.repeat(40),
    workingFolderRemoved: true,
    commits: [
      {
        commit: COMMIT,
        author: 'Ren',
        date: '2026-01-01T00:00:00+00:00',
        merge: false,
        subject: 'Task: Build it',
      },
    ],
    commitsTruncated: false,
    files: [
      { path: 'src/login.ts', added: 10, deleted: 2, binary: false },
      { path: 'logo.png', added: null, deleted: null, binary: true },
    ],
    diff: {
      file: 'changes.diff',
      bytes: 321,
      truncated: false,
      hasControlCharacters: false,
      secretSignals: [],
    },
  },
  checks: { runs: [], total: 0, headline: 'No checks were run on this work.' },
  reviews: { reviews: [], total: 0, headline: 'No independent review was made.' },
  timeline: [],
  timelineTruncated: false,
  ...patch,
})

const run = (patch: Partial<CheckRunRecord> = {}): CheckRunRecord => ({
  id: 'r1',
  commit: COMMIT,
  onFinalCommit: true,
  trigger: 'auto',
  state: 'failed',
  startedAt: '2026-01-01T00:00:01.000Z',
  finishedAt: '2026-01-01T00:00:09.000Z',
  note: null,
  steps: [
    {
      position: 0,
      kind: 'check',
      name: 'Lint',
      command: 'npm run lint',
      state: 'failed',
      exitCode: 1,
      durationMs: 1_500,
      outputTruncated: false,
      logFile: 'checks/run-1-step-1-lint.log',
    },
    {
      position: 1,
      kind: 'check',
      name: 'Test',
      command: 'npm test',
      state: 'passed',
      exitCode: 0,
      durationMs: 90_000,
      outputTruncated: true,
      logFile: null,
    },
  ],
  ...patch,
})

const review = (patch: Partial<ReviewRecord> = {}): ReviewRecord => ({
  id: 'v1',
  reviewer: { id: 'sora', name: 'Sora' },
  commit: COMMIT,
  onFinalCommit: true,
  state: 'submitted',
  verdict: 'request_changes',
  summary: 'The email is not validated.',
  findings: [
    { severity: 'major', file: 'src/login.ts', line: 3, note: 'No validation.' },
    { severity: 'nit', file: null, line: null, note: 'Rename it.' },
  ],
  requestedBy: 'manual',
  createdAt: '2026-01-01T00:00:10.000Z',
  submittedAt: '2026-01-01T00:00:20.000Z',
  note: null,
  ...patch,
})

/** What is left of a report once code spans and fenced blocks, where nothing is interpreted, are taken out. */
function outsideCode(report: string): string {
  return report
    .replace(/^(`{3,})[^\n]*\n[\s\S]*?\n\1$/gm, '')
    .replace(/(`+)[^`\n]([^\n]*?[^`\n])?\1(?!`)/g, '')
}

describe('the report', () => {
  it('says who accepted the work, when, how often it was sent back, and what the checks and a reviewer found', () => {
    const md = renderReport(
      pack({
        checks: {
          runs: [run()],
          total: 1,
          headline: '1 of 2 checks did not pass on the final commit.',
        },
        reviews: {
          reviews: [review()],
          total: 1,
          headline: 'The reviewer asked for changes on the final commit, with 2 findings.',
        },
      }),
    )
    expect(md).toContain(
      '- **Outcome:** Accepted by a person, through Shokuba, at `2026-01-02T00:00:00.000Z`.',
    )
    expect(md).toContain('- **Sent back for changes:** 1 time')
    expect(md).toContain('- **The work:** 1 commit by `Ren`; 2 files changed (+10 −2).')
    expect(md).toContain('- **Checks:** 1 of 2 checks did not pass on the final commit.')
    expect(md).toContain(
      '- **Independent review:** The reviewer asked for changes on the final commit, with 2 findings.',
    )
  })

  it('says plainly when it was not accepted, and who cannot be named', () => {
    const open = renderReport(
      pack({
        task: { ...pack().task, status: 'submitted' },
        outcome: { accepted: false, acceptedAt: null, acceptedBy: null, sentBack: 0 },
      }),
    )
    expect(open).toContain('Not accepted. Its status is submitted.')
    const odd = renderReport(
      pack({ outcome: { accepted: true, acceptedAt: 'x', acceptedBy: 'other', sentBack: 0 } }),
    )
    expect(odd).toContain('Accepted by something other than a person')
    const unknown = renderReport(
      pack({ outcome: { accepted: true, acceptedAt: 'x', acceptedBy: null, sentBack: 0 } }),
    )
    expect(unknown).toContain('Accepted by someone the log does not name')
  })

  it('labels the agent’s summary as a claim nothing was checked against', () => {
    const md = renderReport(pack())
    expect(md).toContain('## What the agent says it did')
    expect(md).toContain('Nothing in this pack was checked against it.')
    expect(renderReport(pack({ task: { ...pack().task, agentSummary: null } }))).toContain(
      'The agent did not submit an account.',
    )
  })

  it('lists each run’s steps with their result, and links only to the log files it made', () => {
    const md = renderReport(pack({ checks: { runs: [run()], total: 1, headline: 'h' } }))
    expect(md).toContain('### Run 1: failed')
    expect(md).toContain(
      '| `Lint` | check | failed | 1 | 2s | [checks/run-1-step-1-lint.log](checks/run-1-step-1-lint.log) |',
    )
    expect(md).toContain('| `Test` | check | passed | 0 | 1m 30s | none |')
    expect(md).toContain('(the final commit)')
    expect(
      renderReport(
        pack({ checks: { runs: [run({ onFinalCommit: false })], total: 1, headline: 'h' } }),
      ),
    ).toContain('(an earlier commit)')
  })

  it('lists each review with its verdict and findings, as advice', () => {
    const md = renderReport(pack({ reviews: { reviews: [review()], total: 1, headline: 'h' } }))
    expect(md).toContain('### Review 1: submitted')
    expect(md).toContain('- **Reviewer:** `Sora`')
    expect(md).toContain('- **Verdict:** request changes')
    expect(md).toContain('| major | `src/login.ts:3` | `No validation.` |')
    expect(md).toContain('| nit | — | `Rename it.` |')
    expect(md).toContain('It is advice: it did not accept or reject the work.')
  })

  it('says what it left out, and what it cannot prove', () => {
    const md = renderReport(
      pack({
        checks: { runs: [run()], total: 25, headline: 'h' },
        reviews: { reviews: [review()], total: 3, headline: 'h' },
        timelineTruncated: true,
        timeline: [
          { seq: 1, ts: '2026-01-01T00:00:00.000Z', source: 'user', text: 'Task created' },
        ],
        work: { ...pack().work, commitsTruncated: true },
      }),
    )
    expect(md).toContain('Showing the newest 1 of 25 runs.')
    expect(md).toContain('Showing the newest 1 of 3 reviews.')
    expect(md).toContain('Only the newest entries are listed.')
    expect(md).toContain('Only the newest commits are listed.')
    expect(md).toContain('| `2026-01-01T00:00:00.000Z` | a person | `Task created` |')
    expect(md).toContain('It is not tamper-proof.')
    expect(md).toContain('it is not signed')
  })

  it('warns about a diff that may hold a secret, and about control characters, without repeating them', () => {
    const md = renderReport(
      pack({
        work: {
          ...pack().work,
          diff: {
            file: 'changes.diff',
            bytes: 10,
            truncated: true,
            hasControlCharacters: true,
            secretSignals: [{ kind: 'api-key', count: 2 }],
          },
        },
      }),
    )
    expect(md).toContain(
      'Check before sharing:** the diff holds 2 values that look like a secret (api-key)',
    )
    expect(md).toContain('control characters')
    expect(md).toContain('cut at the size limit')
  })

  it('says why there is no diff for a task that had no branch of its own', () => {
    const md = renderReport(
      pack({
        work: {
          ...pack().work,
          isolated: false,
          problem: "It ran in the employee's own folder, so there is no diff to show.",
          diff: null,
          files: [],
          commits: [],
        },
      }),
    )
    expect(md).toContain('## The work')
    expect(md).toContain('so there is no diff to show.')
    expect(md).not.toContain('### Commits')
  })
})

describe('text that someone else wrote', () => {
  const hostile =
    '# Fake heading\n[click](https://evil.invalid/x) ![p](https://evil.invalid/p.png) <img src=https://evil.invalid/i.png onerror=alert(1)> | a | b |\n```\nclose the block\n```\n[ref]: https://evil.invalid/ref'
  const evil = pack({
    mission: { id: 'm1', title: hostile, description: hostile, status: 'completed' },
    task: {
      ...pack().task,
      title: hostile,
      description: hostile,
      agentSummary: hostile,
      assignee: { id: 'ren', name: hostile, role: hostile },
      dependsOn: [{ id: 'd', title: hostile, status: 'done' }],
    },
    work: {
      ...pack().work,
      project: hostile,
      branch: hostile,
      commits: [{ commit: COMMIT, author: hostile, date: hostile, merge: false, subject: hostile }],
      files: [{ path: hostile, added: 1, deleted: 1, binary: false }],
    },
    checks: {
      runs: [
        run({
          note: hostile,
          steps: [
            {
              position: 0,
              kind: 'check',
              name: hostile,
              command: hostile,
              state: 'failed',
              exitCode: 1,
              durationMs: 1,
              outputTruncated: false,
              logFile: null,
            },
          ],
        }),
      ],
      total: 1,
      headline: 'h',
    },
    reviews: {
      reviews: [
        review({
          reviewer: { id: 's', name: hostile },
          summary: hostile,
          note: hostile,
          findings: [{ severity: 'major', file: hostile, line: 1, note: hostile }],
        }),
      ],
      total: 1,
      headline: 'h',
    },
    timeline: [{ seq: 1, ts: hostile, source: 'user', text: hostile }],
  })

  it('never becomes a link, an image, HTML or a heading, wherever it appears', () => {
    const rest = outsideCode(renderReport(evil))
    expect(rest).not.toContain('evil.invalid')
    expect(rest).not.toContain('<img')
    expect(rest).not.toContain('Fake heading')
    expect(rest).not.toContain('close the block')
  })

  it('cannot add a heading of its own', () => {
    // A line starting with "#" inside a fenced block is text, not a heading, so leave those out.
    const fenced = /^(`{3,})[^\n]*\n[\s\S]*?\n\1$/gm
    const headings = renderReport(evil)
      .replace(fenced, '')
      .split('\n')
      .filter((line) => /^#{1,6} /.test(line))
    expect(headings.some((line) => line.includes('Fake'))).toBe(false)
    expect(headings).toContain('## Summary')
    expect(headings).toContain('## Timeline')
  })

  it('keeps every row of every table to its own columns, whatever a cell says', () => {
    const md = renderReport(evil)
    const tables: string[][] = []
    let current: string[] = []
    for (const line of md.split('\n')) {
      if (line.startsWith('|')) current.push(line)
      else if (current.length > 0) {
        tables.push(current)
        current = []
      }
    }
    expect(tables.length).toBeGreaterThan(3)
    for (const rows of tables) {
      // Vertical bars a cell escapes do not count: they are text, not the edge of a cell.
      const columns = (row: string): number => (row.match(/(?<!\\)\|/g) ?? []).length
      const expected = columns(rows[0] ?? '')
      expect(rows.map(columns)).toEqual(rows.map(() => expected))
    }
  })

  it('does not let a control character through into the report', () => {
    const md = renderReport(
      pack({ task: { ...pack().task, title: `a${ESC}[2Jb`, agentSummary: `x${ESC}]0;title` } }),
    )
    expect(md).not.toContain(ESC)
  })
})

describe('the files', () => {
  it('are the report, the data, the diff, and a log for each step that printed something', () => {
    const files = renderPack({
      pack: pack({ checks: { runs: [run()], total: 1, headline: 'h' } }),
      diff: 'diff --git a/x b/x\n',
      logs: [{ path: 'checks/run-1-step-1-lint.log', content: 'src/login.ts: unused\n' }],
    })
    expect(files.map((f) => f.path)).toEqual([
      'report.md',
      'evidence.json',
      'changes.diff',
      'checks/run-1-step-1-lint.log',
    ])
    expect(files[2]?.content).toBe('diff --git a/x b/x\n')
  })

  it('keep the diff exactly as it was, and write the data as JSON that reads back the same', () => {
    const p = pack()
    const diff = `+line with ${ESC}[31m escape and trailing space \n`
    const files = renderPack({ pack: p, diff, logs: [] })
    expect(files.find((f) => f.path === 'changes.diff')?.content).toBe(diff)
    expect(JSON.parse(files.find((f) => f.path === 'evidence.json')?.content ?? '')).toEqual(p)
  })

  it('leave out the diff when there is none', () => {
    const files = renderPack({
      pack: pack({ work: { ...pack().work, diff: null } }),
      diff: null,
      logs: [],
    })
    expect(files.map((f) => f.path)).toEqual(['report.md', 'evidence.json'])
  })
})
