import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, scanStateDb, sessionsDb } from '@/modules/database/index.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import type { IProvider } from '@/shared/index.js';

test('GPT Web indexes the configured home independently and disabling it preserves history and other scan progress', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gptweb-index-'));
  const originalDatabase = process.env.DATABASE_PATH;
  const originalHome = process.env.CODEX_GPTWEB_HOME;
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'auth.db');
  process.env.CODEX_GPTWEB_HOME = path.join(root, 'custom-web-profile');
  t.mock.method(os, 'homedir', () => path.join(root, 'user'));
  try {
    await initializeDatabase();
    const codexFile = path.join(root, 'user', '.codex', 'sessions', 'rollout-shared.jsonl');
    const webFile = path.join(process.env.CODEX_GPTWEB_HOME, 'sessions', 'rollout-shared.jsonl');
    for (const file of [codexFile, webFile]) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: 'shared-native-id', cwd: root } }) + '\n');
    }
    assert.equal(await new CodexSessionSynchronizer().synchronize(), 1);
    assert.equal(await new CodexSessionSynchronizer('gptweb').synchronize(), 1);
    const native = sessionsDb.getSessionByProviderSessionId('shared-native-id', 'codex')!;
    const web = sessionsDb.getSessionByProviderSessionId('shared-native-id', 'gptweb')!;
    assert.equal(native.jsonl_path, codexFile);
    assert.equal(web.jsonl_path, webFile);
    assert.notEqual(native.session_id, web.session_id);

    await rm(webFile);
    delete process.env.CODEX_GPTWEB_HOME;
    let codexScans = 0;
    t.mock.method(providerRegistry, 'listProviders', () => [
      { id: 'codex', sessionSynchronizer: { synchronize: async () => { codexScans++; return 0; } } },
      { id: 'gptweb', sessionSynchronizer: { synchronize: async () => { throw new Error('Disabled profile was scanned'); } } },
    ] as unknown as IProvider[]);
    const result = await sessionSynchronizerService.synchronizeSessions();
    assert.equal(codexScans, 1);
    assert.deepEqual(result.failures, []);
    assert.ok(sessionsDb.getSessionById(web.session_id));
  } finally {
    closeConnection();
    if (originalDatabase === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = originalDatabase;
    if (originalHome === undefined) delete process.env.CODEX_GPTWEB_HOME; else process.env.CODEX_GPTWEB_HOME = originalHome;
    await rm(root, { recursive: true, force: true });
  }
});

test('enabling or changing GPT Web homes scans old history independently of the global cursor', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gptweb-scan-'));
  const database = process.env.DATABASE_PATH, home = process.env.CODEX_GPTWEB_HOME;
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  const synchronizer = new CodexSessionSynchronizer('gptweb');
  t.mock.method(providerRegistry, 'listProviders', () => [
    { id: 'gptweb', sessionSynchronizer: synchronizer } as unknown as IProvider,
  ]);
  try {
    await initializeDatabase();
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2100-01-01T00:00:00Z') });
    for (const profile of ['first', 'second']) {
      const sessionsRoot = path.join(root, profile, 'sessions');
      await mkdir(sessionsRoot, { recursive: true });
      await writeFile(path.join(sessionsRoot, 'old.jsonl'), JSON.stringify({
        type: 'session_meta', payload: { id: `${profile}-thread`, cwd: root },
      }) + '\n');
    }
    delete process.env.CODEX_GPTWEB_HOME;
    await sessionSynchronizerService.synchronizeSessions();
    for (const profile of ['first', 'second']) {
      // Simulate scans having continued while this profile was not configured.
      scanStateDb.updateLastScannedAt(new Date('2099-01-01T00:00:00Z'));
      process.env.CODEX_GPTWEB_HOME = path.join(root, profile);
      const result = await sessionSynchronizerService.synchronizeSessions();
      assert.equal(result.processedByProvider.gptweb, 1);
      assert.ok(sessionsDb.getSessionByProviderSessionId(`${profile}-thread`, 'gptweb'));
    }
    // The persisted per-home checkpoint survives a new adapter instance.
    process.env.CODEX_GPTWEB_HOME = path.join(root, 'first');
    assert.equal(await new CodexSessionSynchronizer('gptweb').synchronize(new Date('1900-01-01T00:00:00Z')), 0);
  } finally {
    closeConnection();
    if (database === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = database;
    if (home === undefined) delete process.env.CODEX_GPTWEB_HOME; else process.env.CODEX_GPTWEB_HOME = home;
    await rm(root, { recursive: true, force: true });
  }
});

test('an unreadable GPT Web subtree fails the scan so its old history is retried', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gptweb-scan-error-'));
  const database = process.env.DATABASE_PATH, home = process.env.CODEX_GPTWEB_HOME;
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'auth.db');
  process.env.CODEX_GPTWEB_HOME = path.join(root, 'web');
  await writeFile(process.env.DATABASE_PATH, '');
  const subtree = path.join(process.env.CODEX_GPTWEB_HOME, 'sessions', 'blocked');
  await mkdir(subtree, { recursive: true });
  await writeFile(path.join(subtree, 'old.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'retry-history', cwd: root } }) + '\n');
  const readDirectory = fsPromises.readdir;
  const readdir = t.mock.method(fsPromises, 'readdir', (...args: Parameters<typeof readDirectory>) => {
    if (String(args[0]) === subtree) throw Object.assign(new Error('Cannot read history'), { code: 'EACCES' });
    return readDirectory(...args);
  });
  syncBuiltinESMExports();
  try {
    await initializeDatabase();
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2100-01-01T00:00:00Z') });
    await assert.rejects(new CodexSessionSynchronizer('gptweb').synchronize(), { code: 'EACCES' });
    readdir.mock.restore(); syncBuiltinESMExports();
    assert.equal(await new CodexSessionSynchronizer('gptweb').synchronize(new Date('2099-01-01T00:00:00Z')), 1);
    assert.ok(sessionsDb.getSessionByProviderSessionId('retry-history', 'gptweb'));
  } finally {
    readdir.mock.restore(); syncBuiltinESMExports();
    closeConnection();
    if (database === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = database;
    if (home === undefined) delete process.env.CODEX_GPTWEB_HOME; else process.env.CODEX_GPTWEB_HOME = home;
    await rm(root, { recursive: true, force: true });
  }
});
