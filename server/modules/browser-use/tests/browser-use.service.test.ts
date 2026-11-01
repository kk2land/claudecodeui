import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { browserUseService } from '@/modules/browser-use/browser-use.service.js';
import {
  appConfigDb,
  closeConnection,
  initializeDatabase,
} from '@/modules/database/index.js';

test('browser monitor list starts empty without agent sessions', async () => {
  const sessions = await browserUseService.listSessions();

  assert.deepEqual(sessions, []);
});

test('a stored enabled=true cannot enable settings, status or agent sessions', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-use-disabled-'));
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');

  try {
    await initializeDatabase();
    appConfigDb.set('browser_use_settings', JSON.stringify({ enabled: true }));

    assert.deepEqual(await browserUseService.getSettings(), { enabled: false });
    assert.equal((await browserUseService.getStatus()).enabled, false);
    assert.deepEqual(await browserUseService.updateSettings({ enabled: true }), { enabled: false });
    await assert.rejects(
      () => browserUseService.createAgentSession(),
      /Browser agent tools are disabled/,
    );
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});
