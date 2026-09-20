/** Every IPC channel between renderer and main. One place, so nothing is stringly-typed. */
export const IPC = {
  appInfo: 'shokuba:app:info',
  eventsList: 'shokuba:events:list',
  /** main -> renderer push */
  eventsPublished: 'shokuba:events:published',

  providersList: 'shokuba:providers:list',

  employeesList: 'shokuba:employees:list',
  employeesCreate: 'shokuba:employees:create',
  employeesUpdate: 'shokuba:employees:update',
  employeesArchive: 'shokuba:employees:archive',

  rolesList: 'shokuba:roles:list',
  rolesCreate: 'shokuba:roles:create',
  rolesUpdate: 'shokuba:roles:update',
  rolesDuplicate: 'shokuba:roles:duplicate',
  rolesArchive: 'shokuba:roles:archive',
  rolesReset: 'shokuba:roles:reset',

  departmentsList: 'shokuba:departments:list',
  departmentsCreate: 'shokuba:departments:create',
  departmentsUpdate: 'shokuba:departments:update',
  departmentsArchive: 'shokuba:departments:archive',

  officeGet: 'shokuba:office:get',
  officeSave: 'shokuba:office:save',

  agentsSnapshot: 'shokuba:agents:snapshot',
  agentsStart: 'shokuba:agents:start',
  agentsStop: 'shokuba:agents:stop',
  agentsInterrupt: 'shokuba:agents:interrupt',

  terminalWrite: 'shokuba:terminal:write',
  terminalResize: 'shokuba:terminal:resize',
  terminalReplay: 'shokuba:terminal:replay',
  /** main -> renderer push */
  terminalData: 'shokuba:terminal:data',

  missionsList: 'shokuba:missions:list',
  missionsCreate: 'shokuba:missions:create',
  missionsUpdate: 'shokuba:missions:update',
  missionsAction: 'shokuba:missions:action',
  missionsArchive: 'shokuba:missions:archive',
  missionsBranches: 'shokuba:missions:branches',
  tasksCreate: 'shokuba:tasks:create',
  tasksUpdate: 'shokuba:tasks:update',
  tasksAction: 'shokuba:tasks:action',
  tasksRemove: 'shokuba:tasks:remove',
  tasksChanges: 'shokuba:tasks:changes',
  checksGet: 'shokuba:checks:get',
  checksSave: 'shokuba:checks:save',
  checksSuggest: 'shokuba:checks:suggest',
  checksTask: 'shokuba:checks:task',
  checksRun: 'shokuba:checks:run',
  reviewsTask: 'shokuba:reviews:task',
  reviewsRequest: 'shokuba:reviews:request',
  reviewsSettingsSave: 'shokuba:reviews:settings-save',
  evidenceExport: 'shokuba:evidence:export',

  githubStatus: 'shokuba:github:status',
  githubProjects: 'shokuba:github:projects',
  githubIssues: 'shokuba:github:issues',
  githubImport: 'shokuba:github:import',
  githubLinks: 'shokuba:github:links',
  githubPlanAsk: 'shokuba:github:plan-ask',
  githubPlanTakeBack: 'shokuba:github:plan-take-back',

  messagesList: 'shokuba:messages:list',
  messagesSend: 'shokuba:messages:send',
  messagesRead: 'shokuba:messages:read',
  messagesAction: 'shokuba:messages:action',

  breakerAction: 'shokuba:breaker:action',

  systemPickDirectory: 'shokuba:system:pick-directory',
} as const
