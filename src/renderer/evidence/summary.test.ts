import { describe, expect, it } from 'vitest'
import { canExportEvidence, savedMessage } from './summary'

describe('savedMessage', () => {
  it('says how many files were saved and where', () => {
    expect(
      savedMessage({ folder: '/x/pack', files: ['report.md', 'evidence.json'], warnings: [] }),
    ).toBe('Saved 2 files in a new folder: /x/pack')
    expect(savedMessage({ folder: '/x/pack', files: ['report.md'], warnings: [] })).toBe(
      'Saved 1 file in a new folder: /x/pack',
    )
  })
})

describe('canExportEvidence', () => {
  it('is offered once a task has been handed out, whatever became of it', () => {
    for (const status of [
      'in_progress',
      'submitted',
      'changes_requested',
      'blocked',
      'done',
      'cancelled',
    ]) {
      expect(canExportEvidence(status), status).toBe(true)
    }
  })

  it('is not offered for a task that has not started', () => {
    expect(canExportEvidence('pending')).toBe(false)
    expect(canExportEvidence('ready')).toBe(false)
  })
})
