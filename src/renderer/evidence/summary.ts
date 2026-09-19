import type { EvidenceExportResult } from '@shared/evidence'

/** What to tell the person once a pack is saved: how much, and where. */
export function savedMessage(result: EvidenceExportResult): string {
  const count = result.files.length
  return `Saved ${count} file${count === 1 ? '' : 's'} in a new folder: ${result.folder}`
}

/** Whether a task has got far enough to have a record worth exporting. */
export function canExportEvidence(status: string): boolean {
  return status !== 'pending' && status !== 'ready'
}
