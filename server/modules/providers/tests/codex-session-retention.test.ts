import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { CodexAppServerTransport, codexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.transport.js';
import { cleanupExpiredCodexSessions } from '@/modules/providers/list/codex/codex-session-retention.provider.js';
import { sessionHistoryCache } from '@/modules/providers/services/session-history-cache.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-31T12:00:00Z');
let root: string;
const previousDatabasePath = process.env.DATABASE_PATH;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codex-retention-'));
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

function thread(id: string, source: unknown, age: number, extra: Record<string, unknown> = {}) {
  return { id, source, recencyAt: (NOW - age * DAY) / 1000, updatedAt: (NOW - 60 * DAY) / 1000,
    status: { type: 'notLoaded' }, ...extra };
}

test('retention covers every source and archive page, uses native recency, and removes only successful app mappings', async (t) => {
  const pages = [
    [thread('old-cli', 'cli', 31), thread('recently-opened', 'vscode', 1),
      thread('old-exec', 'exec', 8), thread('exec-boundary', 'exec', 7),
      thread('interactive-boundary', 'appServer', 30)],
    [thread('fallback-null', 'cli', 1, { recencyAt: null }),
      thread('fallback-missing', 'unknown', 1, { recencyAt: undefined }),
      thread('child', { subAgent: { thread_spawn: {} } }, 31),
      thread('active-native', 'cli', 45, { status: { type: 'active', activeFlags: [] } }),
      thread('active-sdk', 'exec', 45)],
    [thread('archived-exec', 'exec', 9), thread('archived-interactive', 'cli', 32),
      thread('failed-exec', 'exec', 9), thread('unindexed-cli', 'unknown', 31)],
  ];
  for (const item of pages.flat()) {
    if (item.id === 'unindexed-cli') continue;
    sessionsDb.createSession(item.id, 'codex', root, item.id, undefined, undefined,
      path.join(root, item.id + '.jsonl'), typeof item.source === 'string' ? item.source : 'unknown');
  }
  sessionsDb.createAppSession('app-old-cli', 'codex', root, 'App name');
  sessionsDb.assignProviderSessionId('app-old-cli', 'old-cli');
  sessionsDb.updateSessionIsArchived('archived-exec', true);
  const invalidate = t.mock.method(sessionHistoryCache, 'invalidate');
  const failures = t.mock.method(console, 'error', () => {});
  const listed: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  t.mock.method(codexAppServerTransport, 'request', async (method: string, params: Record<string, unknown>) => {
    if (method === 'thread/list') {
      listed.push(params);
      const index = params.archived ? 2 : params.cursor ? 1 : 0;
      return { data: pages[index], nextCursor: index === 0 ? 'next-page' : null };
    }
    assert.equal(method, 'thread/delete');
    assert.equal(listed.length, 3, 'all pages must be collected before deleting');
    deleted.push(params.threadId as string);
    if (params.threadId === 'failed-exec') throw new Error('native delete rejected');
    return {};
  });

  const result = await cleanupExpiredCodexSessions(NOW, new Set(['active-sdk']));
  assert.deepEqual(result, {
    exec: { deleted: 2, skipped: 2, failed: 1 },
    other: { deleted: 6, skipped: 3, failed: 0 },
  });
  assert.deepEqual(deleted.sort(), [
    'old-cli', 'old-exec', 'fallback-null', 'fallback-missing', 'child',
    'archived-exec', 'archived-interactive', 'failed-exec', 'unindexed-cli',
  ].sort());
  assert.equal(sessionsDb.getSessionById('app-old-cli'), null);
  assert.ok(sessionsDb.getSessionById('failed-exec'));
  assert.ok(sessionsDb.getSessionById('active-sdk'));
  assert.ok(sessionsDb.getSessionById('recently-opened'));
  assert.ok(invalidate.mock.calls.some((call) => call.arguments[0] === 'app-old-cli'));
  assert.equal(failures.mock.callCount(), 1);
  assert.deepEqual(listed.map((params) => [params.archived, params.cursor]), [
    [false, undefined], [false, 'next-page'], [true, undefined],
  ]);
  for (const params of listed) {
    assert.deepEqual(params.modelProviders, []);
    for (const source of ['exec', 'cli', 'vscode', 'appServer', 'subAgent', 'unknown'])
      assert.ok((params.sourceKinds as string[]).includes(source));
  }
});

test('a failed or malformed native list never starts a partially collected deletion sweep', async (t) => {
  const remove = t.mock.method(codexAppServer, 'deleteThread', async () => {});
  t.mock.method(codexAppServerTransport, 'request', async (_method: string, params: { archived: boolean }) => {
    if (params.archived) throw new Error('archive listing unavailable');
    return { data: [thread('candidate', 'exec', 10)], nextCursor: null };
  });
  await assert.rejects(cleanupExpiredCodexSessions(NOW, new Set()), /archive listing unavailable/);
  assert.equal(remove.mock.callCount(), 0);

  t.mock.method(codexAppServerTransport, 'request', async () => ({
    data: [{ ...thread('candidate', 'exec', 10), updatedAt: 'invalid' }],
  }));
  await assert.rejects(cleanupExpiredCodexSessions(NOW, new Set()));
  assert.equal(remove.mock.callCount(), 0);
});

test('pinned app-server retains opened chats through their policy boundaries and preserves retained fork history', { timeout: 30_000 }, async (t) => {
  const require = createRequire(import.meta.url);
  const launcher = require.resolve('@openai/codex/bin/codex.js');
  const home = path.join(root, 'codex-home');
  const directory = path.join(home, 'sessions', '2026', '08', '01');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(home, 'config.toml'), '');
  const ids = { source: randomUUID(), exec: randomUUID(), archive: randomUUID(), openedCli: randomUUID(), openedExec: randomUUID() };
  const files = new Map<string, string>();
  for (const [kind, id] of Object.entries(ids)) {
    const file = path.join(directory, 'rollout-2026-08-01T00-00-00-' + id + '.jsonl');
    const rows = [
      { timestamp: '2026-08-01T00:00:00Z', type: 'session_meta', payload: {
        id, timestamp: '2026-08-01T00:00:00Z', cwd: root, source: kind === 'exec' || kind === 'openedExec' ? 'exec' : 'cli',
        originator: 'retention-test', cli_version: '0.165.0', model_provider: 'openai',
      } },
      { timestamp: '2026-08-01T00:00:01Z', type: 'response_item', payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'isolated retained fork history' }],
      } },
      { timestamp: '2026-08-01T00:00:01Z', type: 'event_msg', payload: {
        type: 'user_message', message: 'isolated retained fork history', images: [],
      } },
    ];
    await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    await utimes(file, new Date(NOW - 60 * DAY), new Date(NOW - 60 * DAY));
    files.set(id, file);
  }
  const transport = new CodexAppServerTransport({ spawn: () => spawn(process.execPath, [launcher, 'app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_HOME: home },
  }), timeoutMs: 5000 });
  t.mock.method(codexAppServerTransport, 'request', transport.request.bind(transport));
  try {
    // Scan before archiving so the native index has the fixtures.
    await codexAppServer.listThreads(false);
    await transport.request('thread/archive', { threadId: ids.archive });
    const fork = await transport.request('thread/fork', { threadId: ids.source, cwd: root });
    await transport.request('thread/unsubscribe', { threadId: fork.thread.id });
    const sweepAt = Date.now() + 31 * DAY;
    t.mock.method(Date, 'now', () => sweepAt);
    for (const [kind, id] of [['openedCli', ids.openedCli], ['openedExec', ids.openedExec]]) {
      const appId = 'app-' + kind;
      sessionsDb.createSession(id, 'codex', root, 'Opened history', undefined, undefined, files.get(id));
      sessionsDb.createAppSession(appId, 'codex', root);
      sessionsDb.assignProviderSessionId(appId, id);
      const history = await sessionsService.fetchHistory(appId, { offset: 0, limit: 20 });
      assert.ok(JSON.stringify(history.messages).includes('isolated retained fork history'));
      assert.equal(sessionsDb.getSessionById(appId)?.last_opened_at, new Date(sweepAt).toISOString());
    }
    const nativeOpened = (await codexAppServer.listThreads(false)).threads.filter((item) => item.id === ids.openedCli || item.id === ids.openedExec);
    assert.equal(nativeOpened.length, 2);
    assert.ok(nativeOpened.every((item) => item.lastUsedAt < sweepAt - 30 * DAY), 'history reads leave native recency stale');

    const summaries = await cleanupExpiredCodexSessions(sweepAt, new Set([fork.thread.id]));
    assert.equal(summaries.exec.deleted, 1);
    assert.equal(summaries.other.failed, 0);
    const live = await codexAppServer.listThreads(false);
    const archived = await codexAppServer.listThreads(true);
    assert.ok(live.threads.some((item) => item.id === fork.thread.id));
    assert.ok(![...live.threads, ...archived.threads].some((item) => [ids.source, ids.exec, ids.archive].some((id) => id === item.id)));
    assert.ok(live.threads.some((item) => item.id === ids.openedCli));
    assert.ok(live.threads.some((item) => item.id === ids.openedExec));
    await assert.rejects(stat(files.get(ids.exec)!), { code: 'ENOENT' });
    const retained = await transport.request('thread/read', { threadId: fork.thread.id, includeTurns: true });
    assert.ok(JSON.stringify(retained).includes('isolated retained fork history'));

    // Persisted app opens retain each source through its exact policy boundary.
    await cleanupExpiredCodexSessions(sweepAt + 7 * DAY, new Set([fork.thread.id]));
    await stat(files.get(ids.openedExec)!);
    await cleanupExpiredCodexSessions(sweepAt + 7 * DAY + 1, new Set([fork.thread.id]));
    await assert.rejects(stat(files.get(ids.openedExec)!), { code: 'ENOENT' });
    assert.equal(sessionsDb.getSessionById('app-openedExec'), null);
    await cleanupExpiredCodexSessions(sweepAt + 30 * DAY, new Set([fork.thread.id]));
    await stat(files.get(ids.openedCli)!);
    await cleanupExpiredCodexSessions(sweepAt + 30 * DAY + 1, new Set([fork.thread.id]));
    await assert.rejects(stat(files.get(ids.openedCli)!), { code: 'ENOENT' });

    // New paginated forks borrow a prefix instead of copying it. Native delete
    // must be allowed to refuse removing that prefix while the child is kept.
    const paginated = await transport.request('thread/start', { cwd: root, historyMode: 'paginated' });
    await transport.request('thread/inject_items', { threadId: paginated.thread.id, items: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'paginated retained history' }] },
    ] });
    const referenceFork = await transport.request('thread/fork', { threadId: paginated.thread.id, cwd: root });
    await transport.request('thread/unsubscribe', { threadId: referenceFork.thread.id });
    await transport.request('thread/unsubscribe', { threadId: paginated.thread.id });
    const header = JSON.parse((await readFile(referenceFork.thread.path, 'utf8')).split('\n')[0]);
    assert.equal(header.payload.history_base.thread_id, paginated.thread.id);
    await assert.rejects(codexAppServer.deleteThread(paginated.thread.id), /forked history still references it/);
    await stat(paginated.thread.path);
    const readable = await transport.request('thread/read', { threadId: referenceFork.thread.id });
    assert.equal(readable.thread.id, referenceFork.thread.id);
  } finally {
    await transport.close();
  }
});
