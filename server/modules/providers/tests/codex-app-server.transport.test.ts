import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { CodexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.transport.js';
import { CodexAppServerRuntime } from '@/modules/providers/list/codex/codex-app-server.runtime.js';
import type { CodexRpcFrame, SessionRuntimeSettings } from '@/shared/index.js';

function fakeProcess(pid = 43210) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.defineProperty(child, 'pid', { value: pid });
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

test('production spawn explicitly disables Goals unless the env opt-in is true', async (t) => {
  const original = process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
  try {
    for (const enabled of [false, true]) {
      if (enabled) process.env.CLOUDCLI_CODEX_GOAL_ENABLED = 'true';
      else delete process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
      const h = fakeProcess();
      const spawn = t.mock.method(childProcess, 'spawn', () => h.child);
      syncBuiltinESMExports();
      const transport = new CodexAppServerTransport({ timeoutMs: 100 });
      h.onFrame((frame) => { if (frame.id !== undefined) h.reply({ id: frame.id, result: {} }); });
      try {
        await transport.request('ping');
        const args = spawn.mock.calls[0].arguments[1] as string[];
        assert.ok(args.includes(`features.goals=${enabled}`));
        assert.equal(args[args.indexOf(`features.goals=${enabled}`) - 1], '-c');
        assert.ok(args.includes('thread_unload_delay_secs=0'));
      } finally {
        await transport.close();
        spawn.mock.restore();
        syncBuiltinESMExports();
      }
    }
  } finally {
    if (original === undefined) delete process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
    else process.env.CLOUDCLI_CODEX_GOAL_ENABLED = original;
  }
});

test('transport lazily initializes once, correlates out-of-order responses and handles partial lines', async () => {
  const h = fakeProcess();
  assert.equal(h.frames.length, 0);
  assert.equal(h.transport.status.pid, null);
  assert.equal(h.transport.status.startedAt, null);
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
  assert.equal(h.transport.status.pid, h.child.pid);
  await h.transport.close();
  assert.equal(h.transport.status.pid, null);
  assert.equal(h.transport.status.startedAt, null);
});

test('stopping signals the current PID and a later request lazily starts a new process', async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const first = fakeProcess(43210);
  const replacement = fakeProcess(43211);
  const children = [first.child, replacement.child];
  const transport = new CodexAppServerTransport({ spawn: () => children.shift()!, timeoutMs: 100 });
  const kill = t.mock.method(first.child, 'kill');
  first.onFrame((frame) => { if (frame.id !== undefined) first.reply({ id: frame.id, result: {} }); });
  replacement.onFrame((frame) => { if (frame.id !== undefined) replacement.reply({ id: frame.id, result: {} }); });
  try {
    await transport.request('ping');
    assert.equal(transport.status.pid, first.child.pid);
    const firstStartedAt = now;
    assert.equal(transport.status.startedAt, firstStartedAt);
    now += 60_000;
    await transport.request('ping');
    assert.equal(transport.status.startedAt, firstStartedAt);
    await transport.stop();
    assert.deepEqual(kill.mock.calls.map((call) => call.arguments), [['SIGTERM']]);
    assert.equal(transport.status.running, false);
    assert.equal(transport.status.pid, null);
    assert.equal(transport.status.startedAt, null);
    assert.equal(children.length, 1);
    assert.equal(replacement.frames.length, 0);
    await transport.request('ping');
    assert.equal(transport.status.running, true);
    assert.equal(transport.status.pid, replacement.child.pid);
    assert.equal(transport.status.startedAt, now);
    replacement.child.emit('exit', 1, null);
    assert.equal(transport.status.running, false);
    assert.equal(transport.status.pid, null);
    assert.equal(transport.status.startedAt, null);
  } finally {
    await transport.close();
  }
});

test('stopping interrupts pending RPCs, deduplicates signals and excludes racing requests', async (t) => {
  const h = fakeProcess();
  const kill = t.mock.method(h.child, 'kill', () => true);
  let exits = 0;
  h.transport.onExit(() => { exits++; });
  const pending = assert.rejects(h.transport.request('pending'), { code: 'CODEX_APP_SERVER_STOPPED' });
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = h.transport.stop();
  const duplicate = h.transport.stop();
  await assert.rejects(h.transport.request('racing'), { code: 'CODEX_APP_SERVER_STOPPING' });
  assert.equal(h.transport.status.pid, h.child.pid);
  assert.equal(kill.mock.calls.length, 1);
  h.child.stdin.emit('error', new Error('EPIPE'));
  assert.equal(h.transport.status.running, true);
  assert.equal(exits, 0);
  h.child.emit('exit', null, 'SIGTERM');
  await Promise.all([stopping, duplicate, pending]);
  assert.equal(h.transport.status.pendingRequests, 0);
  assert.equal(h.transport.status.pid, null);
  assert.equal(exits, 1);
  assert.equal(h.frames.some((frame) => frame.method === 'racing'), false);
});

test('process stop during a turn abort never lets old cleanup spawn a replacement', async () => {
  const first = fakeProcess(43210);
  const replacement = fakeProcess(43211);
  let spawns = 0;
  const transport = new CodexAppServerTransport({ spawn: () => ++spawns === 1 ? first.child : replacement.child, timeoutMs: 100 });
  let settings: SessionRuntimeSettings = { runtime: 'app-server', mode: 'default', queueHeld: false };
  const runtime = new CodexAppServerRuntime(transport, {
    get: () => settings,
    update: (_id, patch) => settings = { ...settings, ...patch },
  });
  let interrupted!: () => void;
  const interruptSent = new Promise<void>((resolve) => { interrupted = resolve; });
  first.onFrame((frame) => {
    if (frame.id === undefined) return;
    const result = frame.method === 'thread/start' ? { thread: { id: 'native-thread' } }
      : frame.method === 'turn/start' ? { turn: { id: 'turn-1' } } : { goal: null };
    first.reply({ id: frame.id, result });
    if (frame.method === 'turn/interrupt') interrupted();
  });
  replacement.onFrame((frame) => { if (frame.id !== undefined) replacement.reply({ id: frame.id, result: {} }); });
  try {
    const running = runtime.run('hello', { sessionId: 'app-session', cwd: '/tmp' }, { send() {} }, {
      resolveProviderSessionId: () => null,
      resolveResumeModel: async () => 'test-model',
      getProviderModels: async () => ({ DEFAULT: 'test-model', OPTIONS: [] }),
      normalizeMessage: () => [], isProviderInstalled: async () => true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.getState('app-session').turnId, 'turn-1');
    const aborting = runtime.abort('app-session');
    await interruptSent;
    await new Promise((resolve) => setImmediate(resolve));
    await transport.stop();
    assert.equal(await aborting, true);
    await running;
    assert.equal(spawns, 1);
    assert.equal(transport.status.running, false);
    assert.equal(transport.status.pid, null);
    assert.equal(replacement.frames.length, 0);
    assert.equal(first.frames.some(({ method }) => method === 'thread/backgroundTerminals/clean'), false);
    assert.equal(runtime.getState('app-session').phase, 'idle');
  } finally {
    await runtime.close();
    await transport.close();
  }
});

test('an unconfirmed SIGTERM retains the process identity without sending SIGKILL', async (t) => {
  const h = fakeProcess();
  const kill = t.mock.method(h.child, 'kill', () => true);
  const transport = new CodexAppServerTransport({ spawn: () => h.child, stopTimeoutMs: 10 });
  h.onFrame((frame) => { if (frame.id !== undefined) h.reply({ id: frame.id, result: {} }); });
  await transport.request('ping');
  await assert.rejects(transport.stop(), { code: 'CODEX_APP_SERVER_STOP_TIMEOUT' });
  assert.equal(transport.isStopping, true);
  assert.equal(transport.status.pid, h.child.pid);
  assert.equal(transport.status.running, true);
  await assert.rejects(transport.request('ping'), { code: 'CODEX_APP_SERVER_STOPPING' });
  assert.deepEqual(kill.mock.calls.map((call) => call.arguments), [['SIGTERM']]);
  h.child.emit('exit', null, 'SIGTERM');
  assert.equal(transport.status.pid, null);
  assert.equal(transport.isStopping, false);
});

test('a failed signal is reported without pretending the process stopped', async (t) => {
  const h = fakeProcess();
  const kill = t.mock.method(h.child, 'kill', () => false);
  h.onFrame((frame) => { if (frame.id !== undefined) h.reply({ id: frame.id, result: {} }); });
  await h.transport.request('ping');
  await assert.rejects(h.transport.stop(), /Could not send SIGTERM/);
  assert.equal(h.transport.status.pid, h.child.pid);
  await h.transport.request('still-running');
  kill.mock.restore();
  await h.transport.stop();
});

test('stopping before the first request does not spawn a process', async () => {
  let spawns = 0;
  const transport = new CodexAppServerTransport({ spawn: () => { spawns++; return fakeProcess().child; } });
  await transport.stop();
  assert.equal(spawns, 0);
  assert.equal(transport.status.pid, null);
});

test('SIGTERM terminates a real managed child before stop resolves', async () => {
  let managedChild: ChildProcessWithoutNullStreams | undefined;
  const transport = new CodexAppServerTransport({ spawn: () => {
    managedChild = childProcess.spawn(process.execPath, ['-e', `
      require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
        const frame = JSON.parse(line);
        if (frame.id !== undefined) process.stdout.write(JSON.stringify({ id: frame.id, result: {} }) + '\\n');
      });
    `], { stdio: ['pipe', 'pipe', 'pipe'] });
    return managedChild;
  }, timeoutMs: 2000 });
  try {
    await transport.request('ping');
    const pid = transport.status.pid;
    assert.ok(pid);
    await transport.stop();
    assert.equal(managedChild?.signalCode, 'SIGTERM');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(transport.status.pid, null);
  } finally {
    await transport.close();
  }
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
  assert.equal(h.transport.status.pid, h.child.pid);
  assert.equal(typeof h.transport.status.startedAt, 'number');
  await h.transport.close();
});

test('EPIPE clears pending requests and emits one process failure', async () => {
  const h = fakeProcess(); let exits = 0;
  h.transport.onExit(() => { exits++; });
  h.onFrame((frame) => { if (frame.method === 'pending') queueMicrotask(() => h.child.stdin.emit('error', new Error('EPIPE'))); });
  await assert.rejects(h.transport.request('pending'), /EPIPE/);
  assert.equal(h.transport.status.pendingRequests, 0);
  assert.equal(h.transport.status.pid, null);
  assert.equal(h.transport.status.startedAt, null);
  h.child.emit('exit', 1, null);
  assert.equal(exits, 1);
  await h.transport.close();
});
