import { createDepartmentsStore } from './departmentsStore'
import { shokuba } from '../api'

export const useDepartments = createDepartmentsStore({
  list: () => shokuba.departments.list(),
  create: (input) => shokuba.departments.create(input),
  update: (departmentId, patch) => shokuba.departments.update(departmentId, patch),
  archive: (departmentId) => shokuba.departments.archive(departmentId),
})
