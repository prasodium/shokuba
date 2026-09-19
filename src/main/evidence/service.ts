import { promises as fs } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { EvidenceExportResult } from '@shared/evidence'
import type { AuditLog } from '../events/audit'
import { describeError, type Logger } from '../logging/logger'
import { removeTree } from '../platform'
import { EvidenceCollector, EvidenceError, type EvidenceDeps } from './collect'
import { slug } from './markdown'
import { renderPack } from './render'
import type { EvidencePack, PackFile } from './types'

export { EvidenceError } from './collect'

export interface EvidenceServiceDeps extends EvidenceDeps {
  audit: AuditLog
  logger: Logger
}

/** How many folders of the same name are tried before giving up. */
const MAX_FOLDER_TRIES = 50

/** A folder or file name Shokuba made itself: plain letters, digits and a few separators. */
const PLAIN_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/

/**
 * A file's path inside the pack as its parts, or an error if any part is not a plain name Shokuba
 * could have made: no `..`, no absolute path, no drive letter, no odd characters.
 */
export function plainPath(path: string): string[] {
  const segments = path.split('/')
  if (!segments.every((segment) => PLAIN_SEGMENT.test(segment) && !segment.includes('..'))) {
    throw new Error(`refusing to write "${path.slice(0, 40)}"`)
  }
  return segments
}

/** The sentences worth reading before a pack is shared, from what the pack itself says. */
export function warningsFor(pack: EvidencePack): string[] {
  const warnings: string[] = []
  const diff = pack.work.diff
  if (diff) {
    for (const signal of diff.secretSignals) {
      warnings.push(
        `The diff holds ${signal.count} value${signal.count === 1 ? '' : 's'} that look like a secret (${signal.kind}). It is kept exactly as written, so check it before sharing the pack.`,
      )
    }
    if (diff.truncated)
      warnings.push('The diff was cut at the size limit, so it is not the whole change.')
    if (diff.hasControlCharacters) {
      warnings.push('The diff holds control characters; open it in an editor, not a terminal.')
    }
  }
  if (pack.work.commitsTruncated) warnings.push('Only the newest commits are listed.')
  if (pack.checks.total > pack.checks.runs.length) {
    warnings.push(
      `Only the newest ${pack.checks.runs.length} of ${pack.checks.total} runs of the checks are included.`,
    )
  }
  if (pack.reviews.total > pack.reviews.reviews.length) {
    warnings.push(
      `Only the newest ${pack.reviews.reviews.length} of ${pack.reviews.total} reviews are included.`,
    )
  }
  if (pack.timelineTruncated) warnings.push('Only the newest entries of the timeline are listed.')
  if (pack.work.problem && !pack.work.isolated) warnings.push(pack.work.problem)
  return warnings
}

/**
 * Writes an evidence pack into a new folder inside a place the person chose. It never overwrites:
 * the folder is new (a number is added to the name if one is already there), every file is created
 * only if it does not exist, and every name is one Shokuba made from plain characters. If writing
 * fails part-way, what was made is removed, so a half-written pack is never left looking whole.
 */
export class EvidenceService {
  private readonly collector: EvidenceCollector

  constructor(private readonly deps: EvidenceServiceDeps) {
    this.collector = new EvidenceCollector(deps)
  }

  /** The pack as data, without writing anything. */
  async collect(taskId: string): Promise<EvidencePack> {
    return (await this.collector.collect(taskId)).pack
  }

  /**
   * Export a task's pack into `destination`, which must be an existing folder. The caller is
   * responsible for where it came from: it is the person's choice in a dialog, never a path a page
   * sent.
   */
  async export(taskId: string, destination: string): Promise<EvidenceExportResult> {
    if (!isAbsolute(destination)) throw new EvidenceError('Choose a folder to save the pack in.')
    let parent: string
    try {
      parent = await fs.realpath(destination)
      if (!(await fs.stat(parent)).isDirectory()) throw new Error('not a folder')
    } catch {
      throw new EvidenceError('That is not a folder that can be saved into.')
    }

    const collected = await this.collector.collect(taskId)
    const files = renderPack(collected)
    const base = `shokuba-evidence-${slug(collected.pack.task.title)}-${taskId.slice(0, 8).toLowerCase()}`
    const folder = await this.makeFolder(parent, slug(base, 80))

    try {
      await this.write(folder, files)
    } catch (error) {
      this.deps.logger.warn('evidence.export.failed', { taskId, ...describeError(error) })
      await removeTree(folder).catch(() => undefined)
      throw new EvidenceError('The pack could not be saved there, so nothing was kept.')
    }

    this.deps.audit.record({
      actor: 'user',
      action: 'evidence.export',
      target: taskId,
      detail: { files: files.length, folder: folder.split(/[\\/]/).pop() ?? '' },
    })
    return {
      folder,
      files: files.map((file) => file.path),
      warnings: warningsFor(collected.pack),
    }
  }

  /** A new folder inside `parent`, named `name`, or `name-2`, `name-3`… if that is taken. */
  private async makeFolder(parent: string, name: string): Promise<string> {
    for (let attempt = 1; attempt <= MAX_FOLDER_TRIES; attempt += 1) {
      const candidate = join(parent, attempt === 1 ? name : `${name}-${attempt}`)
      try {
        await fs.mkdir(candidate, { mode: 0o700 })
        return candidate
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          this.deps.logger.warn('evidence.folder.failed', describeError(error))
          throw new EvidenceError('That folder cannot be written to.')
        }
      }
    }
    throw new EvidenceError('There are already too many packs for this task in that folder.')
  }

  private async write(folder: string, files: PackFile[]): Promise<void> {
    for (const file of files) {
      const segments = plainPath(file.path)
      let directory = folder
      for (const segment of segments.slice(0, -1)) {
        directory = join(directory, segment)
        await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error
        })
      }
      // "wx": create only if nothing is there, so nothing is overwritten and no link is followed.
      await fs.writeFile(join(directory, segments[segments.length - 1] ?? ''), file.content, {
        flag: 'wx',
        mode: 0o600,
        encoding: 'utf8',
      })
    }
  }
}
