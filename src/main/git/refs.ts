import { GitError } from './runner'

/**
 * The only branches Shokuba ever creates or moves. Every name is built from an id, never from
 * text an agent wrote, and everything that changes a branch checks it is one of these, so a
 * bug or a hostile value can never move `main` or any other branch of yours.
 *
 * Missions and tasks use different prefixes because Git cannot hold both `shokuba/x` and
 * `shokuba/x/y`: a branch name is also a path.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const SAFE_BRANCH = /^shokuba\/(mission|task)\/[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

function checkedId(id: string, what: string): string {
  if (!ID.test(id)) throw new GitError('unsafe', `${what} is not a plain id: "${id.slice(0, 40)}"`)
  return id
}

export const missionBranch = (missionId: string): string =>
  `shokuba/mission/${checkedId(missionId, 'A mission id')}`

export const taskBranch = (taskId: string): string =>
  `shokuba/task/${checkedId(taskId, 'A task id')}`

/** A key that is safe to use as a directory name. */
export const workspaceKey = (id: string): string => checkedId(id, 'A workspace id')

export function assertShokubaBranch(name: string): string {
  if (!SAFE_BRANCH.test(name)) {
    throw new GitError('unsafe', `"${name.slice(0, 60)}" is not a branch Shokuba manages`)
  }
  return name
}

/** A full commit id, or one of Shokuba's own branches: never a revision expression. */
export function assertStartPoint(value: string): string {
  if (COMMIT.test(value) || SAFE_BRANCH.test(value)) return value
  throw new GitError('unsafe', `"${value.slice(0, 60)}" is not a commit id or a Shokuba branch`)
}

/** A commit author's display name: one printable line, no angle brackets. */
export function cleanAuthorName(name: string): string {
  const cleaned = [...name]
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code >= 0x20 && code !== 0x7f && char !== '<' && char !== '>'
    })
    .join('')
    .trim()
    .slice(0, 60)
  return cleaned.length > 0 ? cleaned : 'Shokuba'
}
