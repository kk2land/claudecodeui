import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { CodexAppServerConnections, CodexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.transport.js';
import type { CodexRpcFrame } from '@/shared/index.js';

function harness() {
  const saved = new Map<string, string>([['saved-magpie', 'magpie']]);
  const connections = new Map<string | null, { child: ChildProcessWithoutNullStreams; frames: CodexRpcFrame[]; reply(frame: CodexRpcFrame): void }>();
  let nextThread = 0;
  const pool = new CodexAppServerConnections((selection) => {
    const provider = selection ?? 'openai';
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    Object.defineProperty(child, 'pid', { value: 4000 + connections.size });
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const frames: CodexRpcFrame[] = [];
    const reply = (frame: CodexRpcFrame) => { child.stdout.emit('data', `${JSON.stringify(frame)}\n`); };
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const frame = JSON.parse(String(chunk)) as CodexRpcFrame;
      frames.push(frame);
      queueMicrotask(() => {
        let result: unknown = {};
        if (frame.method === 'initialize') result = { userAgent: 'cloudcli/0.167.2' };
        if (frame.method === 'thread/start') {
          const id = `thread-${++nextThread}`;
          saved.set(id, frame.params?.modelProvider ?? provider);
          result = { thread: { id }, modelProvider: saved.get(id), model: 'shared-model' };
        }
        if (frame.method === 'thread/fork') {
          const id = `fork-${++nextThread}`;
          saved.set(id, provider);
          result = { thread: { id }, model: 'shared-model' };
        }
        if (frame.method === 'turn/start') result = { turn: { id: 'side-turn' } };
        if (frame.method === 'thread/read' || frame.method === 'thread/resume') {
          result = { thread: { id: frame.params!.threadId, modelProvider: saved.get(frame.params!.threadId) } };
        }
        if (frame.method === 'turn/start' && saved.get(frame.params!.threadId) !== provider) {
          reply({ id: frame.id, error: { code: -32600, message: `This chat uses ${saved.get(frame.params!.threadId)}, but your current provider is ${provider}.` } });
          return;
        }
        if (frame.method === 'thread/loaded/list') result = { data: [...saved].filter(([, owner]) => owner === provider).map(([id]) => id) };
        if (frame.id !== undefined) reply({ id: frame.id, result });
      });
      done();
    } });
    child.kill = () => { queueMicrotask(() => child.emit('exit', 0, null)); return true; };
    connections.set(selection, { child, frames, reply });
    return new CodexAppServerTransport({ spawn: () => child, timeoutMs: 100 });
  });
  return { pool, connections };
}

test('explicit services keep first sends, follow-up turns and diagnostics on their owning process', async (t) => {
  const { pool, connections } = harness();
  t.after(() => pool.close());
  assert.equal(connections.size, 0, 'opening controls never starts or allocates a connection');
  const magpie = await pool.request('thread/start', { modelProvider: 'magpie' });
  const openai = await pool.request('thread/start', { modelProvider: 'openai' });
  await pool.request('turn/start', { threadId: magpie.thread.id });
  await pool.request('turn/start', { threadId: openai.thread.id });
  await pool.request('turn/start', { threadId: magpie.thread.id });
  assert.equal(connections.get('magpie')!.frames.filter((frame) => frame.method === 'turn/start').length, 2);
  assert.equal(connections.get('openai')!.frames.filter((frame) => frame.method === 'turn/start').length, 1);
  assert.notEqual(pool.statusForThread(magpie.thread.id).pid, pool.statusForThread(openai.thread.id).pid);
  assert.equal(connections.has(null), false, 'explicit choices never fall back to the default process');
});

test('a cold resume resolves the saved provider before sending any new input', async (t) => {
  const { pool, connections } = harness();
  t.after(() => pool.close());
  await pool.request('thread/read', { threadId: 'saved-magpie' });
  await pool.request('thread/resume', { threadId: 'saved-magpie' });
  await pool.request('turn/start', { threadId: 'saved-magpie' });
  assert.equal(connections.get(null)!.frames.filter((frame) => frame.method === 'thread/read').length, 2);
  assert.equal(connections.get(null)!.frames.some((frame) => frame.method === 'thread/resume' || frame.method === 'turn/start'), false);
  assert.equal(connections.get('magpie')!.frames.filter((frame) => frame.method === 'thread/resume').length, 1);
});

test('a provider exit reports only its threads and leaves the other service usable', async (t) => {
  const { pool, connections } = harness();
  t.after(() => pool.close());
  const magpie = await pool.request('thread/start', { modelProvider: 'magpie' });
  const openai = await pool.request('thread/start', { modelProvider: 'openai' });
  const magpieInstance = pool.instanceIdForThread(magpie.thread.id);
  const openaiInstance = pool.instanceIdForThread(openai.thread.id);
  assert.ok(magpieInstance);
  assert.ok(openaiInstance);
  assert.notEqual(magpieInstance, openaiInstance);
  let affected: ReadonlySet<string> | undefined;
  pool.onExit((_error, _instanceId, threadIds) => { affected = threadIds; });
  connections.get('magpie')!.child.emit('exit', 0, null);
  assert.deepEqual(affected, new Set([magpie.thread.id]));
  assert.equal(pool.statusForThread(magpie.thread.id).running, false);
  assert.equal(pool.statusForThread(openai.thread.id).running, true);
  assert.equal(pool.instanceIdForThread(magpie.thread.id), null);
  assert.equal(pool.instanceIdForThread(openai.thread.id), openaiInstance);
  await pool.request('turn/start', { threadId: openai.thread.id });
});

test('notifications route native child threads and keepalive reaches every live service', async (t) => {
  const { pool, connections } = harness();
  t.after(() => pool.close());
  await pool.request('thread/start', { modelProvider: 'magpie' });
  await pool.request('thread/start', { modelProvider: 'openai' });
  const notifications: CodexRpcFrame[] = [];
  pool.onNotification((frame) => notifications.push(frame));
  connections.get('magpie')!.reply({ method: 'thread/started', params: { thread: { id: 'native-child' } } });
  await pool.request('thread/goal/get', { threadId: 'native-child' });
  assert.equal(connections.get('magpie')!.frames.some((frame) => frame.params?.threadId === 'native-child'), true);
  assert.equal(notifications.length, 1);
  await pool.request('thread/loaded/list');
  for (const connection of connections.values()) assert.equal(connection.frames.filter((frame) => frame.method === 'thread/loaded/list').length, 1);
  await pool.stop();
  assert.deepEqual(await pool.request('thread/loaded/list'), { data: [] });
  assert.equal(connections.size, 2, 'idle keepalive never creates a default connection');
});

for (const operation of ['stop', 'close'] as const) {
  test(`${operation} cancels cold resumes before they allocate another service connection`, async (t) => {
    const { pool, connections } = harness();
    t.after(() => pool.close());
    const resumed = pool.request('thread/resume', { threadId: 'saved-magpie' });
    const rejected = assert.rejects(resumed, { code: 'CODEX_APP_SERVER_STOPPED' });
    let stopped: Promise<void> | undefined;
    const reader = connections.get(null)!;
    reader.child.stdout.on('data', (chunk) => {
      const response = JSON.parse(String(chunk)) as CodexRpcFrame;
      const sent = reader.frames.find((frame) => frame.id === response.id);
      // Stop after metadata has resolved but before the resume continuation runs.
      if (sent?.method === 'thread/read') stopped = pool[operation]();
    });
    await rejected;
    assert.ok(stopped);
    await stopped;
    assert.equal(connections.has('magpie'), false);
    assert.equal(pool.status.running, false);
    if (operation === 'stop') {
      await pool.request('thread/start', { modelProvider: 'magpie' });
      assert.equal(pool.status.running, true, 'a new explicit request may restart after Stop');
    } else {
      await assert.rejects(pool.request('thread/start', { modelProvider: 'magpie' }), /shutting down/);
      assert.equal(connections.has('magpie'), false);
    }
  });
}

test('stopping blocks first requests to other services until the process exit is confirmed', async (t) => {
  const { pool, connections } = harness();
  await pool.request('thread/start', { modelProvider: 'openai' });
  const child = connections.get('openai')!.child;
  child.kill = () => true;
  const stopped = pool.stop();
  t.after(async () => { child.emit('exit', 0, null); await stopped; await pool.close(); });
  assert.equal(pool.isStopping, true);
  await assert.rejects(pool.request('thread/start', { modelProvider: 'magpie' }), { code: 'CODEX_APP_SERVER_STOPPING' });
  assert.equal(connections.has('magpie'), false);
  child.emit('exit', 0, null);
  await stopped;
  assert.equal(pool.isStopping, false);
});

test('an unrelated service exit leaves a magpie side question running to completion', async (t) => {
  const { pool, connections } = harness();
  const abort = new AbortController();
  t.mock.method(codexAppServer, 'transport', () => pool);
  let settled = false;
  const answer = codexAppServer.askSideQuestion({ threadId: 'saved-magpie', cwd: '/project', model: 'shared-model',
    modelProvider: 'magpie', question: 'Which file?', signal: abort.signal }, () => {});
  void answer.then(() => { settled = true; }, () => { settled = true; });
  t.after(async () => { abort.abort(); await answer.catch(() => {}); await pool.close(); });
  for (let i = 0; i < 100 && !connections.get('magpie')?.frames.some((frame) => frame.method === 'turn/start'); i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const magpie = connections.get('magpie')!;
  const turn = magpie.frames.find((frame) => frame.method === 'turn/start');
  assert.ok(turn);
  const forkId = turn.params!.threadId;
  await pool.request('thread/start', { modelProvider: 'openai' });
  connections.get('openai')!.child.emit('exit', 0, null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(magpie.frames.some((frame) => frame.method === 'turn/interrupt' || frame.method === 'thread/unsubscribe'), false);
  magpie.reply({ method: 'item/agentMessage/delta', params: { threadId: forkId, turnId: 'side-turn', delta: 'src/router.ts' } });
  magpie.reply({ method: 'turn/completed', params: { threadId: forkId, turn: { id: 'side-turn', status: 'completed' } } });
  assert.equal(await answer, 'src/router.ts');
});
