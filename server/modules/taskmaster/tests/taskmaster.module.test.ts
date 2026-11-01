import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { taskmasterRoutes } from '../index.js';

test('the production TaskMaster router is closed with an explicit 403', async () => {
  const app = express().use('/api/taskmaster', taskmasterRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/taskmaster/tasks/project-1`);

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
