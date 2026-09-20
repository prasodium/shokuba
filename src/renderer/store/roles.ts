import { createRolesStore } from './rolesStore'

export const useRoles = createRolesStore({
  list: () => window.shokuba.roles.list(),
  create: (input) => window.shokuba.roles.create(input),
  update: (roleId, patch) => window.shokuba.roles.update(roleId, patch),
  duplicate: (roleId) => window.shokuba.roles.duplicate(roleId),
  archive: (roleId) => window.shokuba.roles.archive(roleId),
  reset: (roleId) => window.shokuba.roles.reset(roleId),
})
