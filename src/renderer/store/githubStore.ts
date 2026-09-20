import { create } from 'zustand'
import type {
  GitHubLink,
  GitHubProject,
  GitHubStatus,
  IssueImportRequest,
  IssueSummary,
  IssuesRequest,
} from '@shared/github'
import { errorMessage } from '../lib/errors'
import type { Outcome } from '../lib/outcome'

/** What the store needs from the main process. */
export interface GitHubApi {
  status(): Promise<GitHubStatus>
  projects(): Promise<GitHubProject[]>
  issues(input: IssuesRequest): Promise<IssueSummary[]>
  importIssue(input: IssueImportRequest): Promise<GitHubLink>
  links(): Promise<GitHubLink[]>
}

export type IssueState = 'open' | 'closed' | 'all'

export interface GitHubState {
  /** Whether GitHub can be used; null until it has been checked. */
  status: GitHubStatus | null
  projects: GitHubProject[]
  /** The issues last read, and which project and state they are of. */
  issues: IssueSummary[]
  issuesOf: { repoRoot: string; state: IssueState } | null
  loading: boolean
  /** Why the issues could not be read. */
  error: string | null
  /** The missions that came from issues. */
  links: GitHubLink[]

  /** Find out whether GitHub can be used, and which projects are on it. */
  check(): Promise<void>
  loadIssues(repoRoot: string, state: IssueState): Promise<void>
  importIssue(repoRoot: string, number: number): Promise<Outcome<GitHubLink>>
  refreshLinks(): Promise<void>
}

/** Made from an `api` so it can be tested without a window; the app's own is in `github.ts`. */
export function createGitHubStore(api: GitHubApi) {
  return create<GitHubState>((set, get) => {
    /** The newest of each kind of read, so a slow answer never replaces a newer one. */
    let checkTicket = 0
    let issuesTicket = 0

    return {
      status: null,
      projects: [],
      issues: [],
      issuesOf: null,
      loading: false,
      error: null,
      links: [],

      async check() {
        checkTicket += 1
        const mine = checkTicket
        issuesTicket += 1
        set({ status: null, projects: [], issues: [], issuesOf: null, loading: false, error: null })
        let status: GitHubStatus
        try {
          status = await api.status()
        } catch (error) {
          status = { state: 'error', message: errorMessage(error) }
        }
        if (mine !== checkTicket) return
        set({ status })
        if (status.state !== 'ready') return
        try {
          const projects = await api.projects()
          if (mine === checkTicket) set({ projects })
        } catch (error) {
          if (mine === checkTicket) set({ error: errorMessage(error) })
        }
      },

      async loadIssues(repoRoot, state) {
        issuesTicket += 1
        const mine = issuesTicket
        set({ loading: true, error: null })
        try {
          const issues = await api.issues({ repoRoot, state })
          if (mine === issuesTicket) set({ issues, issuesOf: { repoRoot, state }, loading: false })
        } catch (error) {
          if (mine === issuesTicket) {
            set({ issues: [], issuesOf: null, loading: false, error: errorMessage(error) })
          }
        }
      },

      async importIssue(repoRoot, number) {
        try {
          const link = await api.importIssue({ repoRoot, number })
          await get().refreshLinks()
          return { ok: true, value: link }
        } catch (error) {
          return { ok: false, error: errorMessage(error) }
        }
      },

      async refreshLinks() {
        try {
          set({ links: await api.links() })
        } catch {
          // The next change will read them again.
        }
      },
    }
  })
}
