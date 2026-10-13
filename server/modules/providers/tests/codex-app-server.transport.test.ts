import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { CodexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.transport.js';
import type { CodexRpcFrame } from '@/shared/index.js';

function fakeProcess() {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const frames: CodexRpcFrame[] = [];
  let receive: (frame: CodexRpcFrame) => void = () => {};
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const frame = JSON.parse(String(chunk)) as CodexRpcFrame;
    frames.push(frame);
    if (frame.method === 'initialize') queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: frame.id, result: {} })}\n`));
    else receive(frame);
    done();
  } });
  child.kill = () => { queueMicrotask(() => child.emit('exit', 0, null)); return true; };
  const transport = new CodexAppServerTransport({ spawn: () => child, timeoutMs: 20 });
  return { child, frames, transport, onFrame: (handler: typeof receive) => { receive = handler; },
    reply: (frame: CodexRpcFrame) => child.stdout.emit('data', `${JSON.stringify(frame)}\n`) };
}

test('transport lazily initializes once, correlates out-of-order responses and handles partial lines', async () => {
  const h = fakeProcess();
  assert.equal(h.frames.length, 0);
  h.onFrame((frame) => {
    if (frame.method === 'second') {
      const first = h.frames.find((entry) => entry.method === 'first')!;
      h.child.stdout.emit('data', `noise\n${JSON.stringify({ id: frame.id, result: { value: 2 } })}\n{"id":${first.id},"res`);
      h.child.stdout.emit('data', 'ult":{"value":1}}\n');
    }
  });
  const [one, two] = await Promise.all([h.transport.request('first'), h.transport.request('second')]);
  assert.deepEqual(one, { value: 1 }); assert.deepEqual(two, { value: 2 });
  assert.equal(h.frames.filter((frame) => frame.method === 'initialize').length, 1);
  assert.deepEqual(h.frames[0].params?.capabilities, { experimentalApi: true });
  assert.equal(h.frames[0].params?.clientInfo.name, 'cloudcli');
  await h.transport.close();
});

test('notifications and string-id server questions are independent of client RPC responses', async () => {
  const h = fakeProcess(); const notifications: string[] = [];
  h.transport.onNotification((frame) => notifications.push(frame.method!));
  h.transport.onRequest(async (frame) => ({ answer: frame.params?.question }));
  h.onFrame((frame) => {
    if (frame.method === 'ping') {
      h.reply({ method: 'turn/started', params: {} });
      h.reply({ id: 'native-question', method: 'item/tool/requestUserInput', params: { question: 'yes' } });
      h.reply({ id: frame.id, result: {} });
    }
  });
  await h.transport.request('ping'); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notifications, ['turn/started']);
  assert.deepEqual(h.frames.find((frame) => frame.id === 'native-question')?.result, { answer: 'yes' });
  await h.transport.close();
});

test('RPC timeouts keep the process alive and mark the result as unknown', async () => {
  const h = fakeProcess();
  await assert.rejects(h.transport.request('turn/steer'), (error: any) => error.code === 'CODEX_APP_SERVER_TIMEOUT' && error.details.resultUnknown);
  assert.equal(h.transport.status.running, true);
  assert.equal(h.transport.status.pendingRequests, 0);
  await h.transport.close();
});

test('EPIPE clears pending requests and emits one process failure', async () => {
  const h = fakeProcess(); let exits = 0;
  h.transport.onExit(() => { exits++; });
  h.onFrame((frame) => { if (frame.method === 'pending') queueMicrotask(() => h.child.stdin.emit('error', new Error('EPIPE'))); });
  await assert.rejects(h.transport.request('pending'), /EPIPE/);
  assert.equal(h.transport.status.pendingRequests, 0);
  h.child.emit('exit', 1, null);
  assert.equal(exits, 1);
  await h.transport.close();
});
