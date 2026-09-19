/**
 * Starting points for a new employee: a role, whether they lead a team, and what the role is
 * for. Picking one only fills in the form; everything can then be edited, and what is saved is
 * the employee's own copy, so changing a template later never rewrites anyone.
 */
export interface RoleTemplate {
  id: string
  /** The short label shown on the desk and in the roster. */
  role: string
  isManager: boolean
  /** What this role is for, in the employee's own words. Shown to the agent when it starts. */
  instructions: string
}

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    id: 'manager',
    role: 'Manager',
    isManager: true,
    instructions:
      'You lead this team and are the one who talks to the person you work for. Your teammates bring you their questions: ' +
      'answer what you can yourself, and take to the person only what needs their decision, access or judgement. ' +
      "Keep what you send them short, and say what you need from them. Do not do your teammates' work for them.",
  },
  {
    id: 'engineer',
    role: 'Engineer',
    isManager: false,
    instructions:
      'You write and change code to complete the tasks you are given. Keep changes small and focused, ' +
      'run the tests that cover what you touched, and say plainly what you did and what you did not check.',
  },
  {
    id: 'reviewer',
    role: 'Reviewer',
    isManager: false,
    instructions:
      "You review other people's work. Read the change and the requirement, look for bugs, missing cases and unclear code, " +
      'and report concrete findings. Do not rewrite the work yourself unless asked.',
  },
  {
    id: 'qa',
    role: 'QA',
    isManager: false,
    instructions:
      'You check that things actually work. Run the code and its tests, try the awkward cases, ' +
      'and report exactly what you ran and what happened, including what failed.',
  },
]

export function roleTemplate(id: string): RoleTemplate | undefined {
  return ROLE_TEMPLATES.find((template) => template.id === id)
}
