import { createDepartmentsStore } from './departmentsStore'

export const useDepartments = createDepartmentsStore({
  list: () => window.shokuba.departments.list(),
  create: (input) => window.shokuba.departments.create(input),
  update: (departmentId, patch) => window.shokuba.departments.update(departmentId, patch),
  archive: (departmentId) => window.shokuba.departments.archive(departmentId),
})
