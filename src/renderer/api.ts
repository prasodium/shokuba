import { guardApi } from './replay/guard'
import { isReplaying } from './replay/mode'

/**
 * The window's only way to reach the main process. It is `window.shokuba` with replay's read-only
 * rule in front: while replaying, every call that acts is refused before it leaves the window.
 */
export const shokuba = guardApi(() => window.shokuba, isReplaying)
