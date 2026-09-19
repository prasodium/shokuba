import { useEffect, useState } from 'react'
import type { MissionBranchInfo } from '@shared/git'
import { latestWorkspaceSeq } from '../git/events'
import { branchSummary, mergeInstructions } from '../git/merge'
import { useEvents } from '../store/events'
import { useOffice } from '../store/office'

interface Props {
  missionId: string
  /** Changes whenever the mission's tasks move, so what is shown is read again. */
  version: string
}

/**
 * Where a mission's accepted work is collecting, and how to review and merge it. Shokuba never
 * merges into your own branches: this shows the commands, and you run them.
 */
export function MissionBranchView({ missionId, version }: Props) {
  const platform = useOffice((s) => s.info?.platform ?? 'linux')
  const [branches, setBranches] = useState<MissionBranchInfo[]>([])
  const [open, setOpen] = useState(false)
  const workspaceSeq = useEvents((s) => latestWorkspaceSeq(s.events, { missionId }))

  useEffect(() => {
    let current = true
    window.shokuba.missions
      .branches(missionId)
      .then((result) => {
        if (current) setBranches(result)
      })
      .catch(() => {
        if (current) setBranches([])
      })
    return () => {
      current = false
    }
  }, [missionId, version, workspaceSeq])

  if (branches.length === 0) return null

  return (
    <div className="mission-branch">
      {branches.map((branch) => (
        <div key={`${branch.repoRoot}:${branch.branch}`}>
          <p>
            Accepted work collects on <code>{branch.branch}</code> in{' '}
            <strong>{branch.repoName}</strong>: {branchSummary(branch)}. Your own branches are never
            touched.
          </p>
          {open && (
            <>
              <p className="muted">
                To read it and merge it into whichever branch you have checked out there:
              </p>
              <pre className="commands" aria-label="Commands">
                {mergeInstructions(branch, platform).join('\n')}
              </pre>
            </>
          )}
        </div>
      ))}
      <button type="button" className="btn btn-ghost" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide the commands' : 'How to review and merge it'}
      </button>
    </div>
  )
}
