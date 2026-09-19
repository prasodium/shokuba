import type { CollectedEvidence } from './collect'
import { fence, inline, table } from './markdown'
import { SOURCE_LABELS } from './summary'
import type { CheckRunRecord, EvidencePack, PackFile, ReviewRecord } from './types'

/**
 * The report a person reads. Every piece of text someone else wrote (task text, an agent's
 * summary, a reviewer's words, names, commit subjects, notes, commands) goes in a code span or a
 * fenced block (see `markdown.ts`), so the report cannot be turned into links, images, HTML or
 * different headings by what an agent wrote. Sentences outside those are Shokuba's own, built
 * from counts and states.
 */

// Used in table cells too, so a bar in it can never end the cell.
const short = (commit: string | null): string =>
  commit ? inline(commit.slice(0, 8), { cell: true }) : '—'
const when = (ts: string | null): string => (ts ? inline(ts) : '—')

function duration(ms: number): string {
  if (ms < 1_000) return '<1s'
  const seconds = Math.round(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

const place = (onFinalCommit: boolean | null): string =>
  onFinalCommit === true
    ? 'the final commit'
    : onFinalCommit === false
      ? 'an earlier commit'
      : 'unknown'

function outcomeLine(pack: EvidencePack): string {
  const { outcome, task } = pack
  if (!outcome.accepted) return `Not accepted. Its status is ${task.status}.`
  const by =
    outcome.acceptedBy === 'person'
      ? 'a person, through Shokuba'
      : outcome.acceptedBy === 'other'
        ? 'something other than a person (see the timeline)'
        : 'someone the log does not name'
  return `Accepted by ${by}, at ${when(outcome.acceptedAt)}.`
}

function workLine(pack: EvidencePack): string {
  const { work } = pack
  if (!work.isolated) return work.problem ?? 'There is no record of the work itself.'
  const authors = [...new Set(work.commits.map((c) => c.author))]
  const added = work.files.reduce((sum, f) => sum + (f.added ?? 0), 0)
  const deleted = work.files.reduce((sum, f) => sum + (f.deleted ?? 0), 0)
  const commits = `${work.commits.length} commit${work.commits.length === 1 ? '' : 's'}`
  const by = authors.length > 0 ? ` by ${authors.map((a) => inline(a)).join(', ')}` : ''
  return `${commits}${by}; ${work.files.length} file${work.files.length === 1 ? '' : 's'} changed (+${added} −${deleted}).`
}

function summarySection(pack: EvidencePack): string[] {
  return [
    '## Summary',
    '',
    `- **Outcome:** ${outcomeLine(pack)}`,
    `- **Sent back for changes:** ${pack.outcome.sentBack} time${pack.outcome.sentBack === 1 ? '' : 's'}`,
    `- **The work:** ${workLine(pack)}`,
    `- **Checks:** ${pack.checks.headline}`,
    `- **Independent review:** ${pack.reviews.headline}`,
    '',
  ]
}

function askedSection(pack: EvidencePack): string[] {
  const { task, mission } = pack
  const lines = [
    '## What was asked',
    '',
    `- **Task:** ${inline(task.title)}`,
    `- **Mission:** ${inline(mission.title)}`,
    `- **Assigned to:** ${task.assignee ? `${inline(task.assignee.name)} (${inline(task.assignee.role)})` : 'nobody'}`,
    `- **Priority:** ${task.priority}`,
  ]
  if (task.dependsOn.length > 0) {
    lines.push(
      `- **Waited for:** ${task.dependsOn.map((d) => `${inline(d.title)} (${d.status})`).join(', ')}`,
    )
  }
  lines.push('', task.description ? fence(task.description) : '_No description was given._', '')
  return lines
}

function claimSection(pack: EvidencePack): string[] {
  const { task } = pack
  const lines = ['## What the agent says it did', '']
  if (!task.agentSummary) return [...lines, '_The agent did not submit an account._', '']
  lines.push(
    "This is the agent's own account of its work. Nothing in this pack was checked against it.",
    '',
    fence(task.agentSummary),
    '',
  )
  return lines
}

function workSection(pack: EvidencePack): string[] {
  const { work } = pack
  const lines = ['## The work', '']
  if (!work.isolated) return [...lines, work.problem ?? 'Nothing was recorded.', '']
  lines.push(
    table(
      ['Fact', 'Value'],
      [
        ['Project folder', work.project ? inline(work.project, { cell: true }) : '—'],
        ['Task branch', work.branch ? inline(work.branch, { cell: true }) : '—'],
        ['Started from', short(work.baseCommit)],
        ['Final commit', short(work.finalCommit)],
        [
          'Merged into the mission branch as',
          work.mergeCommit ? short(work.mergeCommit) : 'not merged',
        ],
        [
          'Working folder',
          work.workingFolderRemoved ? 'removed (the branch stays)' : 'still there',
        ],
      ],
    ),
    '',
  )
  if (work.commits.length > 0) {
    lines.push(
      '### Commits',
      '',
      table(
        ['Commit', 'Made by', 'When', 'Message'],
        work.commits.map((c) => [
          short(c.commit),
          inline(c.author, { cell: true }),
          inline(c.date, { cell: true }),
          `${inline(c.subject, { cell: true, max: 120 })}${c.merge ? ' (a merge)' : ''}`,
        ]),
      ),
      '',
    )
    if (work.commitsTruncated) lines.push('_Only the newest commits are listed._', '')
  }
  if (work.files.length > 0) {
    lines.push(
      '### Files changed',
      '',
      table(
        ['File', 'Added', 'Removed'],
        work.files.map((f) => [
          inline(f.path, { cell: true }),
          f.binary ? 'binary' : String(f.added ?? 0),
          f.binary ? 'binary' : String(f.deleted ?? 0),
        ]),
      ),
      '',
    )
  }
  if (work.diff) {
    lines.push(
      `The full change is in \`${work.diff.file}\`, exactly as Git produced it (${work.diff.bytes} bytes${work.diff.truncated ? ', cut at the size limit' : ''}).`,
      '',
    )
    for (const signal of work.diff.secretSignals) {
      lines.push(
        `> **Check before sharing:** the diff holds ${signal.count} value${signal.count === 1 ? '' : 's'} that look like a secret (${signal.kind}). The diff is kept exactly as it is, so it has not been redacted.`,
        '',
      )
    }
    if (work.diff.hasControlCharacters) {
      lines.push(
        '> **Note:** the diff holds control characters (such as terminal escape sequences). Open it in an editor rather than printing it in a terminal.',
        '',
      )
    }
  } else {
    lines.push('_The branch holds no change._', '')
  }
  return lines
}

function stepTable(run: CheckRunRecord): string {
  return table(
    ['Step', 'Kind', 'Result', 'Exit code', 'Took', 'Output'],
    run.steps.map((step) => [
      inline(step.name, { cell: true }),
      step.kind,
      step.state,
      step.exitCode === null ? '—' : String(step.exitCode),
      duration(step.durationMs),
      step.logFile
        ? `[${step.logFile}](${step.logFile})${step.outputTruncated ? ' (the end only)' : ''}`
        : 'none',
    ]),
  )
}

function checksSection(pack: EvidencePack): string[] {
  const { checks } = pack
  const lines = ['## Checks', '', checks.headline, '']
  if (checks.runs.length === 0) return lines
  lines.push(
    'These are commands the person set up, run by Shokuba on the agent-written code. They report what each command did, not whether the work is right.',
    '',
  )
  checks.runs.forEach((run, index) => {
    lines.push(
      `### Run ${index + 1}: ${run.state}`,
      '',
      `- **On commit:** ${short(run.commit)} (${place(run.onFinalCommit)})`,
      `- **Started:** ${when(run.startedAt)}${run.trigger === 'manual' ? ", at a person's request" : ', automatically on submission'}`,
      `- **Finished:** ${when(run.finishedAt)}`,
    )
    if (run.note) lines.push(`- **Note:** ${inline(run.note)}`)
    lines.push('')
    if (run.steps.length > 0) lines.push(stepTable(run), '')
  })
  if (checks.total > checks.runs.length) {
    lines.push(`_Showing the newest ${checks.runs.length} of ${checks.total} runs._`, '')
  }
  return lines
}

function reviewBlock(review: ReviewRecord, index: number): string[] {
  const lines = [
    `### Review ${index + 1}: ${review.state.replace('_', ' ')}`,
    '',
    `- **Reviewer:** ${inline(review.reviewer.name)}`,
    `- **Read commit:** ${short(review.commit)} (${place(review.onFinalCommit)})`,
    `- **Asked:** ${when(review.createdAt)}${review.requestedBy === 'auto' ? ', automatically on submission' : ', by a person'}`,
  ]
  if (review.verdict) lines.push(`- **Verdict:** ${review.verdict.replace('_', ' ')}`)
  if (review.submittedAt) lines.push(`- **Handed in:** ${when(review.submittedAt)}`)
  if (review.note) lines.push(`- **Note:** ${inline(review.note)}`)
  lines.push('')
  if (review.summary) lines.push(fence(review.summary), '')
  if (review.findings.length > 0) {
    lines.push(
      table(
        ['Severity', 'Where', 'Finding'],
        review.findings.map((f) => [
          f.severity,
          f.file ? inline(f.line ? `${f.file}:${f.line}` : f.file, { cell: true }) : '—',
          inline(f.note, { cell: true, max: 400 }),
        ]),
      ),
      '',
    )
  }
  return lines
}

function reviewsSection(pack: EvidencePack): string[] {
  const { reviews } = pack
  const lines = ['## Independent review', '', reviews.headline, '']
  if (reviews.reviews.length === 0) return lines
  lines.push(
    "A review is one employee's opinion of the change, made without seeing the author's own account of it. It is advice: it did not accept or reject the work.",
    '',
  )
  reviews.reviews.forEach((review, index) => lines.push(...reviewBlock(review, index)))
  if (reviews.total > reviews.reviews.length) {
    lines.push(`_Showing the newest ${reviews.reviews.length} of ${reviews.total} reviews._`, '')
  }
  return lines
}

function timelineSection(pack: EvidencePack): string[] {
  if (pack.timeline.length === 0) return ['## Timeline', '', '_Nothing was recorded._', '']
  const lines = [
    '## Timeline',
    '',
    'From Shokuba\'s event log. "Who" is how the log recorded where each event came from.',
    '',
    table(
      ['When', 'Who', 'What'],
      pack.timeline.map((e) => [
        inline(e.ts, { cell: true }),
        SOURCE_LABELS[e.source],
        inline(e.text, { cell: true, max: 300 }),
      ]),
    ),
    '',
  ]
  if (pack.timelineTruncated) lines.push('_Only the newest entries are listed._', '')
  return lines
}

const LIMITS = [
  "This is a record, not a proof. Checks show what commands did; a weak test passes weak work. A review is one model's opinion. The agent's summary is its own claim.",
  "It is not tamper-proof. It is made from Shokuba's database and Git repository on this computer, and it is not signed: anyone who can change those can change what this says.",
  'Commits are the ones on local branches. Nothing was pushed anywhere.',
  'Secret-looking values (by pattern, not a guarantee) are removed from the text of this pack, except in the diff, which is the code exactly as it was written. Read it before you share the pack.',
  'It holds no prompts, model output or terminal transcripts.',
]

export function renderReport(pack: EvidencePack): string {
  const lines: string[] = [
    '# Evidence pack',
    '',
    'What Shokuba recorded about one task: what was asked, what was done, what the checks and a reviewer found, and who accepted it.',
    '',
    `Task ${inline(pack.task.title)} · exported ${when(pack.generatedAt)} by Shokuba ${inline(pack.shokubaVersion)}`,
    '',
    ...summarySection(pack),
    ...askedSection(pack),
    ...claimSection(pack),
    ...workSection(pack),
    ...checksSection(pack),
    ...reviewsSection(pack),
    ...timelineSection(pack),
    '## What this record does not show',
    '',
    ...LIMITS.map((limit) => `- ${limit}`),
    '',
  ]
  return lines.join('\n')
}

/** Every file of a pack, ready to write. Paths are relative to the pack's folder. */
export function renderPack(collected: CollectedEvidence): PackFile[] {
  const { pack, diff, logs } = collected
  const files: PackFile[] = [
    { path: 'report.md', content: renderReport(pack) },
    { path: 'evidence.json', content: `${JSON.stringify(pack, null, 2)}\n` },
  ]
  if (diff !== null && pack.work.diff) files.push({ path: pack.work.diff.file, content: diff })
  for (const log of logs) files.push({ path: log.path, content: log.content })
  return files
}
