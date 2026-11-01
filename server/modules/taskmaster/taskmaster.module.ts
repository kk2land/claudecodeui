import fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import os from 'node:os';

import spawn from 'cross-spawn';
import express from 'express';

import { projectsDb } from '@/modules/database/index.js';

import { createTaskmasterRouter } from './taskmaster.routes.js';
import { createTaskmasterService } from './taskmaster.service.js';

const taskmasterService = createTaskmasterService({
  readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
  getHomeDirectory: os.homedir,
});

// TaskMaster is retired for every instance role. The legacy router below stays
// wired so its implementation and route tests remain intact, but every request
// is answered with an explicit closure before it can scan files or spawn the
// TaskMaster CLI.
const legacyTaskmasterRoutes = createTaskmasterRouter({
  fileSystem: fs,
  fileSystemPromises: fsPromises,
  spawnProcess: spawn,
  resolveProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
  taskmasterService,
});

/** Used by the server entrypoint to mount the closed TaskMaster endpoints. */
export const taskmasterRoutes = express.Router();
taskmasterRoutes.use((_req, res) => {
  res.status(403).json({
    success: false,
    error: {
      code: 'TASKMASTER_DISABLED',
      message: 'TaskMaster is no longer available.',
    },
  });
});
taskmasterRoutes.use(legacyTaskmasterRoutes);
