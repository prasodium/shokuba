/** What exporting a task's evidence pack produced. */
export interface EvidenceExportResult {
  /** The folder that was made, inside the place the person chose. */
  folder: string
  /** The files written, relative to that folder. */
  files: string[]
  /** Things worth knowing before sharing the pack, in plain sentences. */
  warnings: string[]
}
