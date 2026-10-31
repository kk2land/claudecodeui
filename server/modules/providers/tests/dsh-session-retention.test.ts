import assert from 'node:assert/strict';
import fsp, { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { DshConfigurationProvider } from '@/modules/providers/list/dsh/dsh-configuration.provider.js';
import { cleanupExpiredDshSessions } from '@/modules/providers/list/dsh/dsh-session-retention.provider.js';
import { sessionHistoryCache } from '@/modules/providers/services/session-history-cache.service.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-31T12:00:00Z');
let root: string;
const previousDatabasePath = process.env.DATABASE_PATH;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dsh-retention-'));
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

async function log(relative: string, age: number) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'fixture');
  await utimes(file, new Date(NOW - age * DAY), new Date(NOW - age * DAY));
  return file;
}

test('DSH retention removes every expired generation and its index while preserving recent, active, and unrelated files', async (t) => {
  const old = await Promise.all([
    log('sessions/project/expired/session.jsonl', 40),
    log('sessions/project/expired/session.v1.jsonl.zstd', 39),
    log('sessions/project/expired/session.v3.jsonl', 32),
    log('sessions/project/expired/session.v4.jsonl.zstd', 31),
  ]);
  const keep = await Promise.all([
    log('sessions/project/boundary/session.v4.jsonl.zstd', 30),
    log('sessions/project/recent/session.jsonl', 29),
    log('sessions/project/active-native/session.v3.jsonl', 45),
    log('sessions/project/active-native/session.v4.jsonl.zstd', 40),
    log('sessions/project/expired/session.lock', 40),
    log('sessions/project/expired/notes.jsonl', 40),
    log('sessions/project/expired/session.v4.jsonl.tmp', 40),
    log('sessions/project/expired/session.v0.jsonl', 40),
  ]);
  const outside = await log('outside/session.jsonl', 40);
  await symlink(path.dirname(outside), path.join(root, 'sessions', 'linked-directory'));
  await symlink(outside, path.join(root, 'sessions', 'session.jsonl'));
  sessionsDb.createSession('expired', 'dsh', root, 'Expired', undefined, undefined, old.at(-1));
  sessionsDb.createAppSession('app-active', 'dsh', root, 'Active');
  sessionsDb.assignProviderSessionId('app-active', 'active-native');
  sessionsDb.createSession('active-native', 'dsh', root, 'Active', undefined, undefined, keep[3]);
  sessionsDb.createSession('claude-kept', 'claude', root, 'Other provider', undefined, undefined, outside);
  const invalidate = t.mock.method(sessionHistoryCache, 'invalidate');
  const result = await cleanupExpiredDshSessions(NOW, new Set(['active-native']),
    new DshConfigurationProvider({ DSH_HOME: root }));

  assert.deepEqual(result, { deleted: 4, skipped: 4, failed: 0 });
  for (const file of old) await assert.rejects(stat(file), { code: 'ENOENT' });
  for (const file of [...keep, outside]) assert.equal(await readFile(file, 'utf8'), 'fixture');
  assert.equal(sessionsDb.getSessionById('expired'), null);
  assert.ok(sessionsDb.getSessionById('app-active'));
  assert.ok(sessionsDb.getSessionById('claude-kept'));
  assert.deepEqual(invalidate.mock.calls.map((call) => call.arguments[0]), ['expired']);
  assert.deepEqual(sessionsDb.getSessionsWithTranscriptPath('dsh').map((row) => row.session_id), ['app-active']);
});

test('the configured sessions override is honored and failed files do not block other deletions', async (t) => {
  const defaultFile = await log('sessions/project/default/session.jsonl', 40);
  const failed = await log('override/project/failed/session.v4.jsonl.zstd', 40);
  const deleted = await log('override/project/deleted/session.v4.jsonl.zstd', 40);
  for (const [id, file] of [['failed', failed], ['deleted', deleted]]) {
    sessionsDb.createSession(id, 'dsh', root, id, undefined, undefined, file);
  }
  const unlink = fsp.unlink;
  const mocked = t.mock.method(fsp, 'unlink', async (file: Parameters<typeof fsp.unlink>[0]) => {
    if (file === failed) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
    return unlink(file);
  });
  const errors = t.mock.method(console, 'error', () => {});
  syncBuiltinESMExports();
  try {
    const result = await cleanupExpiredDshSessions(NOW, new Set(), new DshConfigurationProvider({
      DSH_HOME: root, CLOUDCLI_DSH_SESSIONS_DIR: path.join(root, 'override'),
    }));
    assert.deepEqual(result, { deleted: 1, skipped: 0, failed: 1 });
    assert.equal(await readFile(defaultFile, 'utf8'), 'fixture');
    assert.equal(await readFile(failed, 'utf8'), 'fixture');
    await assert.rejects(stat(deleted), { code: 'ENOENT' });
    assert.ok(sessionsDb.getSessionById('failed'));
    assert.equal(sessionsDb.getSessionById('deleted'), null);
    assert.equal(errors.mock.callCount(), 1);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('an absent DSH session root is an empty sweep', async () => {
  assert.deepEqual(await cleanupExpiredDshSessions(NOW, new Set(), new DshConfigurationProvider({
    DSH_HOME: path.join(root, 'missing-home'),
  })), { deleted: 0, skipped: 0, failed: 0 });
});

test('a linked DSH home deletes canonical index entries while retaining active sessions', async (t) => {
  const expired = await log('physical-home/sessions/project/expired/session.v4.jsonl', 40);
  const active = await log('physical-home/sessions/project/active/session.v4.jsonl', 40);
  const home = path.join(root, 'linked-home');
  await symlink(path.join(root, 'physical-home'), home);
  // DshSessionStore.read returns realpath even when the configured home is a link.
  sessionsDb.createSession('expired', 'dsh', root, 'Expired', undefined, undefined, await realpath(expired));
  sessionsDb.createSession('active', 'dsh', root, 'Active', undefined, undefined, await realpath(active));
  const invalidate = t.mock.method(sessionHistoryCache, 'invalidate');

  const result = await cleanupExpiredDshSessions(NOW, new Set(['active']), new DshConfigurationProvider({ DSH_HOME: home }));

  assert.deepEqual(result, { deleted: 1, skipped: 1, failed: 0 });
  await assert.rejects(stat(expired), { code: 'ENOENT' });
  assert.equal(sessionsDb.getSessionById('expired'), null);
  assert.deepEqual(invalidate.mock.calls.map((call) => call.arguments[0]), ['expired']);
  await stat(active);
  assert.ok(sessionsDb.getSessionById('active'));
});
