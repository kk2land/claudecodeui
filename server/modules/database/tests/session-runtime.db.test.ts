import assert from 'node:assert/strict';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionDraftsDb, sessionRuntimeDb, sessionsDb, userDb } from '@/modules/database/index.js';

test('process stop persists holds for every native Codex queue while preserving messages, modes and other runtimes', async () => {
  const previousDatabase = process.env.DATABASE_PATH;
  const previousRuntime = process.env.CLOUDCLI_CODEX_RUNTIME_MODE;
  closeConnection();
  process.env.DATABASE_PATH = ':memory:';
  try {
    await initializeDatabase();
    const userId = Number(userDb.createUser('queue-stop-test', 'hash').id);
    for (const defaultRuntime of ['app-server', 'sdk']) {
      process.env.CLOUDCLI_CODEX_RUNTIME_MODE = defaultRuntime;
      const ids = ['default', 'native', 'sdk', 'claude'].map((id) => `${defaultRuntime}-${id}`);
      for (const id of ids) {
        sessionsDb.createAppSession(id, id.endsWith('claude') ? 'claude' : 'codex', '/tmp');
        sessionDraftsDb.saveDraft(userId, id, { text: '', queuedMessage: { id, content: `pending ${id}` } });
      }
      sessionRuntimeDb.update(ids[1], { runtime: 'app-server', mode: 'plan' });
      sessionRuntimeDb.update(ids[2], { runtime: 'sdk' });
      const before = sessionDraftsDb.getDrafts(userId);
      sessionRuntimeDb.holdCodexAppServerQueues();
      assert.deepEqual(sessionRuntimeDb.get(ids[1]), { runtime: 'app-server', mode: 'plan', queueHeld: true });
      assert.equal(sessionRuntimeDb.get(ids[0]).queueHeld, defaultRuntime === 'app-server');
      assert.equal(sessionRuntimeDb.get(ids[2]).queueHeld, false);
      assert.equal(sessionRuntimeDb.get(ids[3]).queueHeld, false);
      assert.deepEqual(sessionDraftsDb.getDrafts(userId), before);
      sessionRuntimeDb.update(ids[1], { queueHeld: false });
      assert.equal(sessionRuntimeDb.get(ids[1]).queueHeld, false);
    }
  } finally {
    closeConnection();
    if (previousDatabase === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabase;
    if (previousRuntime === undefined) delete process.env.CLOUDCLI_CODEX_RUNTIME_MODE;
    else process.env.CLOUDCLI_CODEX_RUNTIME_MODE = previousRuntime;
  }
});

test('DSH transport and queue holds survive reconnecting to the database without changing Codex settings', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'dsh-runtime-settings-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = join(directory, 'auth.db');
  try {
    await initializeDatabase();
    sessionsDb.createAppSession('dsh-settings', 'dsh', directory);
    sessionsDb.createAppSession('codex-settings', 'codex', directory);
    sessionRuntimeDb.update('codex-settings', { runtime: 'sdk', mode: 'plan', queueHeld: true });
    assert.equal(sessionRuntimeDb.getDsh('dsh-settings'), null);
    sessionRuntimeDb.saveDsh('dsh-settings', { runtime: 'headless', queueHeld: false });
    sessionRuntimeDb.saveDsh('dsh-settings', { runtime: 'acp', queueHeld: true });
    closeConnection();
    await initializeDatabase();
    assert.deepEqual(sessionRuntimeDb.getDsh('dsh-settings'), { runtime: 'acp', queueHeld: true });
    assert.deepEqual(sessionRuntimeDb.get('codex-settings'), { runtime: 'sdk', mode: 'plan', queueHeld: true });
    assert.equal(sessionRuntimeDb.getDsh('codex-settings'), null);
    sessionRuntimeDb.holdCodexAppServerQueues();
    assert.deepEqual(sessionRuntimeDb.getDsh('dsh-settings'), { runtime: 'acp', queueHeld: true });
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
