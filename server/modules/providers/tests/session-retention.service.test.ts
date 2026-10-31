import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';
import { setImmediate as settle } from 'node:timers/promises';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { createSessionRetentionService } from '@/modules/providers/services/session-retention.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

const empty = { deleted: 0, skipped: 0, failed: 0 };
let root: string;
const previousDatabasePath = process.env.DATABASE_PATH;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'retention-scheduler-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
});
afterEach(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  await rm(root, { recursive: true, force: true });
});

test('each startup sweeps immediately, including a restart in the same day', async (t) => {
  t.mock.method(console, 'info', () => {});
  let now = new Date(2026, 9, 31, 10).getTime();
  const calls: number[] = [];
  const options = {
    now: () => now,
    cleanupCodex: async (at: number) => { calls.push(at); return { exec: empty, other: empty }; },
    cleanupDsh: async () => empty,
  };
  const first = createSessionRetentionService(options);
  first.start();
  await settle();
  assert.deepEqual(calls, [now]);
  await first.close();

  const restarted = createSessionRetentionService(options);
  restarted.start();
  await settle();
  assert.deepEqual(calls, [now, now]);
  await restarted.close();

  now = new Date(2026, 10, 4, 8).getTime();
  const afterDowntime = createSessionRetentionService(options);
  afterDowntime.start();
  await settle();
  assert.deepEqual(calls, [new Date(2026, 9, 31, 10).getTime(), new Date(2026, 9, 31, 10).getTime(), now]);
  await afterDowntime.close();
});

test('the timer repeats every 24 hours from startup without duplicate initialization and stops on shutdown', async (t) => {
  t.mock.method(console, 'info', () => {});
  const start = new Date(2026, 9, 31, 8, 17, 43).getTime();
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: start });
  let sweeps = 0;
  const service = createSessionRetentionService({
    now: () => Date.now(),
    cleanupCodex: async () => { sweeps++; return { exec: empty, other: empty }; },
    cleanupDsh: async () => empty,
  });
  try {
    service.start();
    await settle();
    assert.equal(sweeps, 1);
    service.start();
    t.mock.timers.tick(86_400_000 - 1);
    assert.equal(sweeps, 1);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(sweeps, 2);
    t.mock.timers.tick(86_400_000);
    await settle();
    assert.equal(sweeps, 3);
    await service.close();
    t.mock.timers.tick(86_400_000);
    assert.equal(sweeps, 3);
  } finally {
    await service.close();
  }
});

test('active app/native and SDK ids are protected, provider failures are isolated, and shutdown drains a single sweep', async (t) => {
  t.mock.method(console, 'info', () => {});
  const errors = t.mock.method(console, 'error', () => {});
  for (const [appId, nativeId, provider] of [
    ['app-sdk', 'native-sdk', 'codex'], ['app-native', 'native-app-server', 'codex'],
    ['app-dsh', 'native-dsh', 'dsh'],
  ]) {
    sessionsDb.createAppSession(appId, provider, root, appId);
    sessionsDb.assignProviderSessionId(appId, nativeId);
  }
  t.mock.method(chatRunRegistry, 'listRunningRuns', () => [
    { sessionId: 'app-sdk', provider: 'codex', startedAt: 0, lastSeq: 0 },
  ]);
  const resolveProvider = providerRegistry.resolveProvider;
  t.mock.method(providerRegistry, 'resolveProvider', (id: string) => {
    const provider = resolveProvider(id);
    return { ...provider, runtime: { ...provider.runtime, listActiveSessions: () => [
      { sessionId: id === 'codex' ? 'app-native' : 'app-dsh', startedAt: 0 },
    ] } };
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let count = 0;
  const service = createSessionRetentionService({
    now: () => new Date(2026, 9, 31, 10).getTime(),
    cleanupCodex: async (_at, ids) => {
      count++;
      assert.deepEqual([...ids].sort(), ['native-app-server', 'native-sdk']);
      await held;
      return { exec: empty, other: empty };
    },
    cleanupDsh: async (_at, ids) => {
      assert.deepEqual([...ids], ['native-dsh']);
      throw new Error('fixture DSH failure');
    },
  });
  const sweep = service.run();
  assert.equal(service.run(), sweep);
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await Promise.all([sweep, closing]);
  assert.equal(count, 1);
  assert.equal(closed, true);
  assert.equal(errors.mock.callCount(), 1);
  await service.run();
  assert.equal(count, 1);
});
