import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import projectRoutes from '../projects.routes.js';

test('project taskmaster metadata is closed instead of scanning the project', async () => {
  const app = express().use('/api/projects', projectRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/projects/project-1/taskmaster`);

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      success: false,
      error: {
        code: 'TASKMASTER_DISABLED',
        message: 'TaskMaster is no longer available.',
      },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
