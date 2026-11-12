// createProjectSchedulerModule: mounted by the server composition root; owns
// resident binding lifecycle, the scheduler plugin IPC channel, restart
// recovery and the session resident session projection.
export { createProjectSchedulerModule } from './project-scheduler.module.js';
// Host service types: consumed by the composition root (session projection and
// dispatcher wiring); nothing outside the server imports them.
export type { ResidentHostService } from './resident-host.service.js';
// readResidentSessionInfo: used by the providers running-sessions feed and the
// projects session list, which are the UI's only source of menu metadata.
export { readResidentSessionInfo } from './resident-session-projection.js';
