/** Every IPC channel between renderer and main. One place, so nothing is stringly-typed. */
export const IPC = {
  appInfo: 'shokuba:app:info',
  eventsList: 'shokuba:events:list',
  /** main -> renderer push */
  eventsPublished: 'shokuba:events:published',
} as const
