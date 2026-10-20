import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { DshConfigurationProvider } from '@/modules/providers/list/dsh/dsh-configuration.provider.js';
import { DshSessionStore } from '@/modules/providers/list/dsh/dsh-session-store.provider.js';
import { DshSessionSynchronizer } from '@/modules/providers/list/dsh/dsh-session-synchronizer.provider.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-synchronizer-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  const cwd = path.join(root, 'workspace');
  const store = new DshSessionStore(new DshConfigurationProvider({ DSH_HOME: root }));
  return {
    cwd,
    synchronizer: new DshSessionSynchronizer(store),
    async log(id: string) {
      const directory = path.join(root, 'sessions', 'workspace', id);
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, 'session.v4.jsonl');
      await writeFile(file, JSON.stringify({ type: 'session', version: 4, id, cwd, createdAt: 1, isSeeded: false, delegationDepth: 0 }) + '\n');
      return file;
    },
    async close() {
      closeConnection();
      if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('scanning old DSH history never claims a pending app session in the same project', async () => {
  const f = await fixture();
  try {
    sessionsDb.createAppSession('new-app', 'dsh', f.cwd, 'New conversation');
    const file = await f.log('old-native');
    await f.synchronizer.synchronizeFile(file);
    assert.equal(sessionsDb.getSessionById('new-app')?.provider_session_id, null);
    assert.equal(sessionsDb.getSessionById('old-native')?.provider_session_id, 'old-native');
    await f.synchronizer.synchronize();
    assert.equal(sessionsDb.getSessionById('new-app')?.provider_session_id, null);
  } finally { await f.close(); }
});

test('DSH watcher imports and later exact runtime mappings preserve both concurrent app sessions', async () => {
  const f = await fixture();
  try {
    sessionsDb.createAppSession('app-one', 'dsh', f.cwd, 'First conversation');
    sessionsDb.createAppSession('app-two', 'dsh', f.cwd, 'Second conversation');
    const one = await f.log('native-one'), two = await f.log('native-two');
    await f.synchronizer.synchronizeFile(one);
    await f.synchronizer.synchronizeFile(two);
    // Native logs can arrive before either session/new reply. Only the
    // runtime's exact id announcement may merge an imported row into an app.
    sessionsDb.assignProviderSessionId('app-two', 'native-two');
    sessionsDb.assignProviderSessionId('app-one', 'native-one');
    await f.synchronizer.synchronize();
    assert.equal(sessionsDb.getSessionById('app-one')?.provider_session_id, 'native-one');
    assert.equal(sessionsDb.getSessionById('app-two')?.provider_session_id, 'native-two');
    assert.equal(sessionsDb.getSessionById('app-one')?.custom_name, 'First conversation');
    assert.equal(sessionsDb.getSessionById('app-two')?.custom_name, 'Second conversation');
    assert.equal(sessionsDb.getSessionById('app-one')?.jsonl_path, one);
    assert.equal(sessionsDb.getSessionById('app-two')?.jsonl_path, two);
    assert.equal(sessionsDb.getSessionById('native-one'), null);
    assert.equal(sessionsDb.getSessionById('native-two'), null);
  } finally { await f.close(); }
});
