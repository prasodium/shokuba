import { createRolesStore } from './rolesStore'
import { shokuba } from '../api'

export const useRoles = createRolesStore({
  list: () => shokuba.roles.list(),
  create: (input) => shokuba.roles.create(input),
  update: (roleId, patch) => shokuba.roles.update(roleId, patch),
  duplicate: (roleId) => shokuba.roles.duplicate(roleId),
  archive: (roleId) => shokuba.roles.archive(roleId),
  reset: (roleId) => shokuba.roles.reset(roleId),
})
