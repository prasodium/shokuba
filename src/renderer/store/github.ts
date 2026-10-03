import { createGitHubStore } from './githubStore'
import { shokuba } from '../api'

export const useGitHub = createGitHubStore({
  status: () => shokuba.github.status(),
  projects: () => shokuba.github.projects(),
  issues: (input) => shokuba.github.issues(input),
  importIssue: (input) => shokuba.github.importIssue(input),
  links: () => shokuba.github.links(),
  askToPlan: (missionId, managerId) => shokuba.github.askToPlan(missionId, managerId),
  takeBackPlan: (missionId) => shokuba.github.takeBackPlan(missionId),
  pullPreview: (missionId) => shokuba.github.pullPreview(missionId),
  pullOpen: (input) => shokuba.github.pullOpen(input),
  pullStatus: (missionId) => shokuba.github.pullStatus(missionId),
  pullFollowUp: (input) => shokuba.github.pullFollowUp(input),
})
