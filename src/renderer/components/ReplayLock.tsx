import type { ReactNode } from 'react'
import { REPLAY_REFUSAL } from '../replay/guard'
import { useReplaying } from '../store/timeline'

/**
 * Everything inside is switched off during replay and says why. It changes nothing about layout.
 * The guard in front of the API refuses acting calls anyway; this is so nobody is offered one.
 */
export function ReplayLock({ children }: { children: ReactNode }) {
  const replaying = useReplaying()
  return (
    <fieldset
      className="replay-lock"
      disabled={replaying}
      title={replaying ? REPLAY_REFUSAL : undefined}
    >
      {children}
    </fieldset>
  )
}
