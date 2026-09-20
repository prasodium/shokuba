import { fence, inline, scrubPaths } from '../evidence/markdown'
import { redactString } from '../security/redact'
import { MAX_PULL_TITLE } from './client'
import { cleanLine } from './text'

/** What one accepted task adds to the pull request's text. */
export interface PullTaskRecord {
  /** The task's title, written by a person or an agent. */
  title: string
  /** What the agent said it did: its own words. */
  summary: string | null
  /** Shokuba's own sentences about the checks and the review, made from counts and states only. */
  checks: string
  review: string
}

/** The most of an agent's own summary that goes into the text. */
export const MAX_SUMMARY = 1_500

/** The pull request's title: the issue's own title, on one line, or a plain one if it has none. */
export function pullTitle(issueTitle: string, issueNumber: number): string {
  const title = cleanLine(issueTitle, MAX_PULL_TITLE)
  return title.length > 0 ? title : `Changes for issue #${issueNumber}`
}

/**
 * The pull request's text, written from what Shokuba recorded. It starts `Closes #N` so the issue
 * closes when the person merges it.
 *
 * Everything an agent or a person wrote (a task's title, an agent's summary) goes in as a code span
 * or a fenced block, where nothing is interpreted: it can never become a link, an image, HTML, a
 * mention that notifies someone, or a reference to another issue. What an agent said is also stripped
 * of anything that looks like a secret or a full path on the person's computer. The sentences
 * around it are Shokuba's own.
 */
export function pullBody(input: {
  issueNumber: number
  commitCount: number
  tasks: readonly PullTaskRecord[]
  tasksNotDone: number
}): string {
  const lines = [`Closes #${input.issueNumber}`, '', '## What was done', '']
  if (input.tasks.length === 0) lines.push('No task has been accepted yet.', '')
  for (const task of input.tasks) {
    lines.push(`### ${inline(task.title, { max: 120 })}`, '', `${task.checks} ${task.review}`, '')
    if (task.summary && task.summary.trim().length > 0) {
      lines.push(
        '<details><summary>What the agent said it did</summary>',
        '',
        fence(scrubPaths(redactString(task.summary)), MAX_SUMMARY),
        '',
        '</details>',
        '',
      )
    }
  }
  const commits = `${input.commitCount} commit${input.commitCount === 1 ? '' : 's'}`
  lines.push(
    '## About this pull request',
    '',
    `This is ${commits} of work done by AI agents, each task in its own branch, and a person accepted each task before it was added here. What an agent said it did is its own account, not a checked claim; the changes themselves are the record.`,
  )
  if (input.tasksNotDone > 0) {
    lines.push(
      '',
      `${input.tasksNotDone} other task${input.tasksNotDone === 1 ? ' was' : 's were'} not finished, so ${input.tasksNotDone === 1 ? 'its' : 'their'} work is not here.`,
    )
  }
  return `${lines.join('\n')}\n`
}
