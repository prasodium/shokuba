import { createGitHubStore } from './githubStore'

export const useGitHub = createGitHubStore({
  status: () => window.shokuba.github.status(),
  projects: () => window.shokuba.github.projects(),
  issues: (input) => window.shokuba.github.issues(input),
  importIssue: (input) => window.shokuba.github.importIssue(input),
  links: () => window.shokuba.github.links(),
})
