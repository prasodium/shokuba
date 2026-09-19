/**
 * One thing at a time may move an agent. Handing an agent a task, and handing it a review,
 * both stop it, start it afresh in a new folder and paste a briefing, across several waits. If
 * both were allowed to act on the same idle agent at once they would each restart it under the
 * other. Whoever holds the agent finishes before anyone else may touch it.
 */
export class AgentLock {
  private readonly held = new Set<string>()

  /** Take the agent if nobody holds it. Returns whether it was taken. */
  acquire(employeeId: string): boolean {
    if (this.held.has(employeeId)) return false
    this.held.add(employeeId)
    return true
  }

  release(employeeId: string): void {
    this.held.delete(employeeId)
  }

  isHeld(employeeId: string): boolean {
    return this.held.has(employeeId)
  }
}
