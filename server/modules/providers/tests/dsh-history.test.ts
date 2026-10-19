import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { zstdCompressSync, constants } from 'node:zlib';

import { DshConfigurationProvider } from '@/modules/providers/list/dsh/dsh-configuration.provider.js';
import { DshSessionStore } from '@/modules/providers/list/dsh/dsh-session-store.provider.js';
import { DshSessionsProvider } from '@/modules/providers/list/dsh/dsh-sessions.provider.js';
import { DshEventsProvider } from '@/modules/providers/list/dsh/dsh-events.provider.js';

test('native history selects the newest generation, applies replacements, and paginates from the tail', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-history-'));
  try {
    const directory = path.join(root, 'sessions', 'workspace', 'native-1');
    await mkdir(directory, { recursive: true });
    const header = { type: 'session', version: 4, id: 'native-1', createdAt: 1, cwd: root, isSeeded: false, delegationDepth: 0 };
    const user = (seq: number, text: string) => ({ type: 'user/message', seq, time: seq + 1, surfaceOp: 'append', data: { id: `user-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } });
    const events = [user(0, 'old'), { ...user(1, 'replacement'), surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0] }, user(2, 'latest')];
    const file = path.join(directory, 'session.v4.jsonl');
    const original = [header, ...events].map((row) => JSON.stringify(row)).join('\n') + '\n{"partial":';
    await writeFile(file, original);
    await writeFile(path.join(directory, 'session.jsonl'), 'not the selected generation');
    const store = new DshSessionStore(new DshConfigurationProvider({ DSH_HOME: root }));
    assert.deepEqual(await store.files(), [file]);
    const sessions = new DshSessionsProvider(store, new DshEventsProvider());
    const latest = await sessions.fetchHistory('app-1', { providerSessionId: 'native-1', limit: 1 });
    assert.deepEqual(latest.messages.map((message) => message.content), ['latest']);
    assert.equal(latest.total, 2);
    assert.equal(latest.hasMore, true);
    assert.equal(latest.messages[0].sessionId, 'app-1');
    const older = await sessions.fetchHistory('app-1', { providerSessionId: 'native-1', limit: 1, offset: 1 });
    assert.deepEqual(older.messages.map((message) => message.content), ['replacement']);
    assert.equal((await sessions.fetchHistory('app-1', { providerSessionId: 'native-1', limit: 0 })).messages.length, 0);
    assert.equal(await readFile(file, 'utf8'), original, 'reader must not repair or migrate the native file');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('compressed native history accepts complete checksummed frames before an unfinished append', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-zstd-'));
  try {
    const directory = path.join(root, 'sessions', 'workspace', 'native-2');
    await mkdir(directory, { recursive: true });
    const header = { type: 'session', version: 4, id: 'native-2', createdAt: 1, cwd: root, isSeeded: false, delegationDepth: 0 };
    const event = { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: { id: 'user-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '中文✅' }] } };
    const compress = (value: unknown) => zstdCompressSync(`${JSON.stringify(value)}\n`, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
    const content = Buffer.concat([compress(header), compress(event), compress(event).subarray(0, 7)]);
    const file = path.join(directory, 'session.v4.jsonl.zstd');
    await writeFile(file, content);
    const store = new DshSessionStore(new DshConfigurationProvider({ DSH_HOME: root }));
    assert.equal((await store.find('native-2'))?.events[0].data.content[0].text, '中文✅');
    assert.deepEqual(await readFile(file), content);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native reader rejects unknown versions and paths escaping the configured root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-invalid-history-'));
  try {
    const directory = path.join(root, 'sessions', 'workspace', 'future');
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, 'session.v999.jsonl');
    await writeFile(file, JSON.stringify({ type: 'session', version: 999, id: 'future', createdAt: 1, isSeeded: false, delegationDepth: 0 }) + '\n');
    const store = new DshSessionStore(new DshConfigurationProvider({ DSH_HOME: root }));
    await assert.rejects(store.read(file), /version|format|unsupported/i);
    const outside = path.join(root, 'outside.jsonl');
    await writeFile(outside, '{}\n');
    await assert.rejects(store.read(outside), /outside/);
    if (process.platform !== 'win32') {
      const linked = path.join(directory, 'linked.jsonl');
      await symlink(outside, linked);
      await assert.rejects(store.read(linked), /outside/);
    }
    await assert.rejects(store.find('../escape'), /invalid|must|path/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
