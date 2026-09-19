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

  messagesList: 'shokuba:messages:list',
  messagesSend: 'shokuba:messages:send',
  messagesRead: 'shokuba:messages:read',
  messagesAction: 'shokuba:messages:action',

  breakerAction: 'shokuba:breaker:action',

  systemPickDirectory: 'shokuba:system:pick-directory',
} as const
