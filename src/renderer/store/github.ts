import { createGitHubStore } from './githubStore'

export const useGitHub = createGitHubStore({
  status: () => window.shokuba.github.status(),
  projects: () => window.shokuba.github.projects(),
  issues: (input) => window.shokuba.github.issues(input),
  importIssue: (input) => window.shokuba.github.importIssue(input),
  links: () => window.shokuba.github.links(),
  askToPlan: (missionId, managerId) => window.shokuba.github.askToPlan(missionId, managerId),
  takeBackPlan: (missionId) => window.shokuba.github.takeBackPlan(missionId),
  pullPreview: (missionId) => window.shokuba.github.pullPreview(missionId),
  pullOpen: (input) => window.shokuba.github.pullOpen(input),
  pullStatus: (missionId) => window.shokuba.github.pullStatus(missionId),
  pullFollowUp: (input) => window.shokuba.github.pullFollowUp(input),
})
