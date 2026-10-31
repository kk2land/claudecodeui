import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { CodexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.transport.js';
import { CodexAppServerRuntime } from '@/modules/providers/list/codex/codex-app-server.runtime.js';
import { AppError } from '@/shared/index.js';
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
    reply: (frame: CodexRpcFrame) => child.stdout.emit('data', `${JSON.stringify(frame)}\n`),
    reject: (frame: CodexRpcFrame, message: string) => child.stdout.emit('data', `${JSON.stringify({ id: frame.id, error: { code: -32603, message } })}\n`) };
}

// The exact error the user reported. The app-server wraps the thread-store
// failure, so the retry matcher must recognise this whole string — including
// the real rollout path — and not merely a cut-down suffix of it.
function emptyRolloutMessage(file = '/Users/agent/workspaces/tap/.codex/sessions/2026/10/21/rollout-2026-10-21T21-34-22-01a15e74-9c29-7ad3-ad63-0fca9258ec00.jsonl') {
  return `failed to read thread: thread-store internal error: failed to read session metadata ${file}: rollout at ${file} is empty`;
}

// The same failure surfaced without the app-server's thread-read wrapper.
function unwrappedEmptyRolloutMessage(file = '/Users/agent/.codex/sessions/2026/10/21/rollout-2026-10-21T21-34-22-01a15e74-9c29-7ad3-ad63-0fca9258ec00.jsonl') {
  return `failed to read session metadata ${file}: rollout at ${file} is empty`;
}

test('production spawn preserves Goals flags and supplies a disabled Worker transport', async (t) => {
  const original = process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
  try {
    for (const enabled of [false, true]) {
      if (enabled) process.env.CLOUDCLI_CODEX_GOAL_ENABLED = 'true';
      else delete process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
      const h = fakeProcess();
      const spawn = t.mock.method(childProcess, 'spawn', () => h.child);
      syncBuiltinESMExports();
      const transport = new CodexAppServerTransport({ timeoutMs: 100 });
      transport.setWorkerMcpUrl('http://127.0.0.1:3001/api/worker-mcp');
      h.onFrame((frame) => { if (frame.id !== undefined) h.reply({ id: frame.id, result: {} }); });
      try {
        await transport.request('ping');
        const args = spawn.mock.calls[0].arguments[1] as string[];
        assert.ok(args.includes(`features.goals=${enabled}`));
        assert.equal(args[args.indexOf(`features.goals=${enabled}`) - 1], '-c');
        assert.ok(args.includes('thread_unload_delay_secs=0'));
        assert.ok(args.includes('mcp_servers.cloudcli_workers.url="http://127.0.0.1:3001/api/worker-mcp"'));
        assert.ok(args.includes('mcp_servers.cloudcli_workers.enabled=false'));
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

test('a proxy exit with code zero reports a clean transport exit without starting a replacement', async () => {
  const h = fakeProcess();
  const exits: Error[] = [];
  h.transport.onExit((error) => { exits.push(error); });
  h.onFrame((frame) => { if (frame.id !== undefined) h.reply({ id: frame.id, result: {} }); });
  await h.transport.request('ping');
  h.child.emit('exit', 0, null);
  assert.equal(exits.length, 1);
  assert(exits[0] instanceof AppError);
  assert.equal(exits[0].code, 'CODEX_APP_SERVER_CLEAN_EXIT');
  assert.equal(h.transport.status.running, false);
  assert.equal(h.frames.filter((frame) => frame.method === 'initialize').length, 1);
  await h.transport.close();
});

test('transport reads the CLI version from the initialize echo, keeping a prerelease suffix', async () => {
  // The initialize echo is `<clientName>/<cliVersion> ...`; the adapter must not
  // assume the client name is `codex` and must keep the prerelease intact so the
  // runtime's protocol gate can tell stable from alpha.
  for (const [userAgent, expected] of [
    ['cloudcli/0.163.0 (Mac OS; arm64) dumb (cloudcli; 1.0.0)', '0.163.0'],
    ['cloudcli/0.163.0-alpha.11 (Mac OS; arm64) dumb (cloudcli; 1.0.0)', '0.163.0-alpha.11'],
  ]) {
    const h = fakeProcess();
    // Re-wire stdin so every frame is acknowledged, and initialize echoes the
    // realistic clientName/version userAgent.
    h.child.stdin = new Writable({ write(chunk, _encoding, done) {
      const frame = JSON.parse(String(chunk)) as CodexRpcFrame;
      if (frame.method === 'initialize') {
        queueMicrotask(() => h.child.stdout.emit('data', `${JSON.stringify({ id: frame.id, result: { userAgent } })}\n`));
      } else if (frame.id !== undefined) {
        queueMicrotask(() => h.child.stdout.emit('data', `${JSON.stringify({ id: frame.id, result: {} })}\n`));
      }
      done();
    } }) as typeof h.child.stdin;
    const transport = new CodexAppServerTransport({ spawn: () => h.child, timeoutMs: 100 });
    try {
      await transport.request('ping');
      assert.equal(transport.status.cliVersion, expected, `cliVersion for ${userAgent}`);
    } finally {
      await transport.close();
    }
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
  }, undefined, undefined, undefined, undefined, {
    modelProviders: {
      list: async () => ({ defaultProvider: 'openai', hasCustomProviders: false, providers: [{ id: 'openai', name: 'OpenAI' }] }),
      models: async (modelProvider) => ({ modelProvider, models: ['test-model'], expiresAt: 0 }),
    },
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

test('turn/start waits out a queued proxy acknowledgement while other RPCs keep the 30-second deadline', async (t) => {
  const h = fakeProcess();
  const transport = new CodexAppServerTransport({ spawn: () => h.child });
  let startFrame: CodexRpcFrame | undefined;
  h.onFrame((frame) => {
    if (frame.id === undefined) return;
    if (frame.method === 'turn/start') { startFrame = frame; return; }
    if (frame.method === 'thread/read') return;
    h.reply({ id: frame.id, result: {} });
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const start = transport.request('turn/start', { threadId: 'native-thread' });
    const other = transport.request('thread/read', { threadId: 'native-thread' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(startFrame, 'turn/start was written');

    t.mock.timers.tick(30_000);
    await assert.rejects(other, (error: any) => error.code === 'CODEX_APP_SERVER_TIMEOUT');
    assert.equal(transport.status.pendingRequests, 1, 'turn/start remains pending past the ordinary deadline');

    // Just short of the 15-minute budget, the acknowledgement still settles it.
    t.mock.timers.tick(15 * 60_000 - 30_000 - 1);
    assert.equal(transport.status.pendingRequests, 1);
    h.reply({ id: startFrame!.id, result: { turn: { id: 'turn-1' } } });
    assert.deepEqual(await start, { turn: { id: 'turn-1' } });
    assert.equal(transport.status.pendingRequests, 0);
  } finally {
    t.mock.timers.reset();
    await transport.close();
  }
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

for (const method of ['thread/read', 'thread/resume'] as const) {
  test(`${method} retries one transient empty rollout on the same process and returns its result`, async () => {
    const h = fakeProcess();
    const seen: string[] = [];
    h.onFrame((frame) => {
      if (frame.id === undefined) return;
      seen.push(frame.method!);
      if (seen.length === 1) return h.reject(frame, emptyRolloutMessage());
      h.reply({ id: frame.id, result: { thread: { id: 'native-thread', turns: [] } } });
    });
    const result = await h.transport.request(method, { threadId: 'native-thread', includeTurns: true });
    assert.deepEqual(result, { thread: { id: 'native-thread', turns: [] } });
    assert.deepEqual(seen, [method, method]);
    assert.equal(h.frames.filter((frame) => frame.method === 'initialize').length, 1, 'retry must not re-handshake');
    assert.equal(h.transport.status.pid, h.child.pid);
    assert.equal(h.transport.status.pendingRequests, 0);
    await h.transport.close();
  });
}

test('a persistently empty rollout stops at the bounded attempt count with the original error', async () => {
  const h = fakeProcess();
  const seen: Array<{ id?: string | number; method?: string; params?: unknown }> = [];
  h.onFrame((frame) => {
    if (frame.id === undefined) return;
    seen.push({ id: frame.id, method: frame.method, params: frame.params });
    h.reject(frame, emptyRolloutMessage());
  });
  const params = { threadId: 'native-thread', includeTurns: true };
  await assert.rejects(h.transport.request('thread/read', params), (error: any) => {
    assert.equal(error.code, 'CODEX_APP_SERVER_REJECTED');
    // The complete native message survives, not a rewritten or truncated one.
    assert.equal(error.message, emptyRolloutMessage());
    return true;
  });
  assert.equal(seen.length, 3, 'three total attempts');
  assert.ok(seen.every((frame) => frame.method === 'thread/read' && JSON.stringify(frame.params) === JSON.stringify(params)), 'same method and params every attempt');
  assert.equal(h.transport.status.pendingRequests, 0);
  assert.equal(h.transport.status.pid, h.child.pid, 'bounded failure keeps the process');
  await h.transport.close();
});

test('the exact reported error is retried, while malformed or arbitrary wrappers fail immediately', async () => {
  const pathWithSpaces = '/Users/agent/my sessions/2026/10/21/rollout-2026-10-21T21-34-22-01a15e74.jsonl';
  const cases: Array<[string, 'retry' | RegExp | ((message: string) => boolean)]> = [
    [emptyRolloutMessage(), 'retry'],
    [emptyRolloutMessage(pathWithSpaces), 'retry'],
    // Only the one known app-server wrapper is an allowed prefix.
    [unwrappedEmptyRolloutMessage(), 'retry'],
    ['failed to read thread: failed to read session metadata /tmp/session.jsonl: rollout at /tmp/session.jsonl is empty', /failed to read thread/],
    ['unexpected prefix: failed to read thread: thread-store internal error: failed to read session metadata /tmp/session.jsonl: rollout at /tmp/session.jsonl is empty', /unexpected prefix/],
    ['failed to read thread: thread-store internal error: failed to read session metadata /tmp/session.jsonl: unexpected end of file', /unexpected end of file/],
    ['failed to read thread: thread-store internal error: failed to read session metadata /tmp/session.jsonl: rollout at /tmp/session.jsonl is empty but the index is corrupt', /is empty but the index is corrupt/],
    ['failed to read thread: thread-store internal error: rollout at /tmp/session.jsonl is empty', /thread-store internal error/],
    ['failed to read thread: thread-store internal error: failed to read session metadata /tmp/session.jsonl: rollout at /tmp/other.jsonl is empty', /failed to read session metadata/],
    [`${emptyRolloutMessage()}\n`, /empty\n/],
    ['', (message: string) => message === ''],
  ];
  for (const [message, expected] of cases) {
    const h = fakeProcess();
    let attempts = 0;
    h.onFrame((frame) => {
      if (frame.id === undefined) return;
      attempts++;
      // The recognised shape recovers on the second attempt; the rest must not repeat.
      if (expected === 'retry' && attempts > 1) return h.reply({ id: frame.id, result: { thread: { id: 'native-thread' } } });
      h.reject(frame, message);
    });
    if (expected === 'retry') {
      assert.deepEqual(await h.transport.request('thread/read', { threadId: 'native-thread' }), { thread: { id: 'native-thread' } }, message);
      assert.equal(attempts, 2, message);
    } else if (typeof expected === 'function') {
      await assert.rejects(h.transport.request('thread/read', { threadId: 'native-thread' }), (error: any) => expected(error.message));
      assert.equal(attempts, 1, 'must not retry an empty message');
    } else {
      await assert.rejects(h.transport.request('thread/read', { threadId: 'native-thread' }), expected, message);
      assert.equal(attempts, 1, `must not retry: ${message}`);
    }
    await h.transport.close();
  }
});

test('empty-rollout retries exclude turn/start, turn/steer, thread/fork and non-rejection failures', async () => {
  for (const method of ['turn/start', 'turn/steer', 'thread/fork', 'thread/goal/get']) {
    const h = fakeProcess();
    let attempts = 0;
    h.onFrame((frame) => { if (frame.id !== undefined) { attempts++; h.reject(frame, emptyRolloutMessage()); } });
    await assert.rejects(h.transport.request(method, { threadId: 'native-thread' }), /is empty/);
    assert.equal(attempts, 1, `${method} must not be retried`);
    await h.transport.close();
  }
  // A timeout has an unknown outcome; repeating it could submit work twice.
  const timedOut = fakeProcess();
  await assert.rejects(timedOut.transport.request('thread/read', { threadId: 'native-thread' }), { code: 'CODEX_APP_SERVER_TIMEOUT' });
  assert.equal(timedOut.frames.filter((frame) => frame.method === 'thread/read').length, 1);
  assert.equal(timedOut.transport.status.pendingRequests, 0);
  await timedOut.transport.close();
});

test('a stop during the retry wait aborts the retry without signalling or spawning a replacement', async (t) => {
  const h = fakeProcess();
  const kill = t.mock.method(h.child, 'kill', () => true);
  h.onFrame((frame) => { if (frame.id !== undefined) h.reject(frame, emptyRolloutMessage()); });
  const pending = assert.rejects(h.transport.request('thread/read', { threadId: 'native-thread' }), /is empty/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const stopping = h.transport.stop();
  await pending;
  // The retry wait observed the stop instead of re-sending to the child.
  assert.equal(h.frames.filter((frame) => frame.method === 'thread/read').length, 1);
  assert.deepEqual(kill.mock.calls.map((call) => call.arguments), [['SIGTERM']]);
  assert.equal(h.transport.status.pendingRequests, 0);
  h.child.emit('exit', null, 'SIGTERM');
  await stopping;
  assert.equal(h.transport.status.running, false);
  await h.transport.close();
});

test('a child exit during the retry wait fails the read instead of re-sending to a replacement', async () => {
  const first = fakeProcess(43210);
  const replacement = fakeProcess(43211);
  const children = [first.child, replacement.child];
  let spawns = 0;
  const transport = new CodexAppServerTransport({ spawn: () => { spawns++; return children.shift()!; }, timeoutMs: 100 });
  first.onFrame((frame) => { if (frame.id !== undefined) first.reject(frame, emptyRolloutMessage()); });
  replacement.onFrame((frame) => { if (frame.id !== undefined) replacement.reply({ id: frame.id, result: { thread: {} } }); });
  const pending = assert.rejects(transport.request('thread/read', { threadId: 'native-thread' }), /is empty/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  first.child.emit('exit', 1, null);
  await pending;
  assert.equal(first.frames.filter((frame) => frame.method === 'thread/read').length, 1);
  assert.equal(spawns, 1, 'the retry must not restart the process');
  assert.equal(transport.status.running, false);
  assert.equal(transport.status.pendingRequests, 0);
  // A later explicit request may lazily start a new process, but it carries no retried read.
  await transport.request('ping');
  assert.equal(transport.status.pid, replacement.child.pid);
  assert.equal(replacement.frames.filter((frame) => frame.method === 'thread/read').length, 0);
  await transport.close();
});

test('closing during the retry wait ends the request with the original error and cleans pending state', async () => {
  const h = fakeProcess();
  h.onFrame((frame) => { if (frame.id !== undefined) h.reject(frame, emptyRolloutMessage()); });
  const pending = assert.rejects(h.transport.request('thread/read', { threadId: 'native-thread' }), /is empty/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await h.transport.close();
  await pending;
  assert.equal(h.frames.filter((frame) => frame.method === 'thread/read').length, 1);
  assert.equal(h.transport.status.pendingRequests, 0);
  assert.equal(h.transport.status.running, false);
  // A closed transport refuses new work rather than reviving the child.
  await assert.rejects(h.transport.request('thread/read', { threadId: 'native-thread' }), /shutting down/);
});

test('default production transport reports the bundled CLI without spawning or sending RPC', async (t) => {
  // A lazy `status` read must expose the bundled 0.165.0 identity so a mounted
  // session can opt into predictions before the first send, while spawning
  // nothing and sending no RPC.
  const spawned = t.mock.method(childProcess, 'spawn', () => { throw new Error('must not spawn'); });
  syncBuiltinESMExports();
  try {
    const transport = new CodexAppServerTransport();
    const status = transport.status;
    assert.equal(status.running, false);
    assert.equal(status.pid, null);
    assert.equal(status.startedAt, null);
    assert.equal(status.pendingRequests, 0);
    assert.ok(status.launcherPath && status.launcherPath.endsWith('codex.js'), 'bundled launcher path is known');
    assert.equal(status.cliVersion, '0.165.0');
    assert.equal(spawned.mock.callCount(), 0, 'reading status must never spawn the process');

    // The runtime surfaces the same installed-build capability from that status.
    let settings: SessionRuntimeSettings = { runtime: 'app-server', mode: 'default', queueHeld: false };
    const runtime = new CodexAppServerRuntime(transport, { get: () => settings, update: (_, patch) => (settings = { ...settings, ...patch }) }, 100, () => {});
    assert.equal(runtime.getState('cold-session').predictionSupported, true);
    assert.equal(runtime.getState('cold-session').diagnostics?.cliVersion, '0.165.0');
    assert.equal(spawned.mock.callCount(), 0);
    await runtime.close();
  } finally {
    spawned.mock.restore();
    syncBuiltinESMExports();
  }
});

test('a custom spawn never borrows the bundled CLI version', async () => {
  const h = fakeProcess();
  const status = h.transport.status;
  assert.equal(status.launcherPath, null);
  assert.equal(status.cliVersion, null, 'a custom spawn must wait for its real handshake');
  await h.transport.close();
});

// ---------------------------------------------------------------------------
// End-to-end through the runtime: the real transport retry must let the user's
// `restoreHistory` path recover, and a failed thread/read must still never be
// reported as a successful Stop.
// ---------------------------------------------------------------------------
function runtimeHarness(timeoutMs = 20) {
  const h = fakeProcess();
  // fakeProcess defaults to a 20ms RPC timeout; a Stop test needs turn/start to
  // stay pending while it aborts.
  const transport = new CodexAppServerTransport({ spawn: () => h.child, timeoutMs });
  let settings: SessionRuntimeSettings = { runtime: 'app-server', mode: 'default', queueHeld: false };
  const runtime = new CodexAppServerRuntime(transport, {
    get: () => settings,
    update: (_id, patch) => { settings = { ...settings, ...patch }; return settings; },
  }, 2000, () => {});
  const writer = { send() {}, setSessionId() {}, nextTurn() { return writer; } };
  const context = {
    resolveProviderSessionId: () => 'native-thread',
    resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ DEFAULT: 'test-model', OPTIONS: [] }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  };
  return { ...h, transport, runtime, writer, context };
}

test('runtime history restoration recovers from one empty rollout response', async () => {
  const h = runtimeHarness();
  let reads = 0;
  h.onFrame((frame) => {
    if (frame.id === undefined) return;
    if (frame.method === 'thread/resume') h.reply({ id: frame.id, result: { thread: { id: 'native-thread' } } });
    else if (frame.method === 'thread/goal/get') h.reply({ id: frame.id, result: { goal: null } });
    else if (frame.method === 'thread/read') {
      reads++;
      if (reads === 1) h.reject(frame, emptyRolloutMessage());
      else h.reply({ id: frame.id, result: { thread: { turns: [{ id: 'turn-1', items: [] }] } } });
    } else h.reply({ id: frame.id, result: {} });
  });
  try {
    const state = await h.runtime.control('app-session', { action: 'goal', operation: 'get' }, { sessionId: 'app-session', cwd: '/tmp' }, h.writer, h.context);
    assert.equal(reads, 2, 'one transient empty read is retried');
    assert.equal(state.phase, 'idle', 'restoreHistory observed the recovered result');
    assert.equal(h.transport.status.pendingRequests, 0);
    assert.equal(h.transport.status.pid, h.child.pid);
  } finally {
    await h.runtime.close();
    await h.transport.close();
  }
});

test('runtime reports a persistently empty restore and never confirms a stop through it', async () => {
  const h = runtimeHarness();
  let reads = 0;
  h.onFrame((frame) => {
    if (frame.id === undefined) return;
    if (frame.method === 'thread/resume') h.reply({ id: frame.id, result: { thread: { id: 'native-thread' } } });
    else if (frame.method === 'thread/read') { reads++; h.reject(frame, emptyRolloutMessage()); }
    else h.reply({ id: frame.id, result: {} });
  });
  try {
    await assert.rejects(h.runtime.control('app-session', { action: 'goal', operation: 'get' }, { sessionId: 'app-session', cwd: '/tmp' }, h.writer, h.context), /is empty/);
    assert.equal(reads, 3, 'bounded attempts, then the original error surfaces');
    assert.equal(h.transport.status.pendingRequests, 0);
  } finally {
    await h.runtime.close();
    await h.transport.close();
  }
});

test('an empty-rollout Stop confirmation read is bounded and reported as an unconfirmed stop', async () => {
  const h = runtimeHarness(500);
  let reads = 0;
  h.onFrame((frame) => {
    if (frame.id === undefined) return;
    if (frame.method === 'turn/start') return; // stays unanswered below
    if (frame.method === 'thread/start') h.reply({ id: frame.id, result: { thread: { id: 'native-thread' } } });
    else if (frame.method === 'thread/goal/get') h.reply({ id: frame.id, result: { goal: null } });
    // An uncertain turn id is exactly when Stop must re-read the thread.
    else if (frame.method === 'thread/read') { reads++; h.reject(frame, emptyRolloutMessage()); }
    else h.reply({ id: frame.id, result: {} });
  });
  const context = { ...h.context, resolveProviderSessionId: () => null };
  let running: Promise<unknown> | null = null;
  try {
    running = h.runtime.run('hello', { sessionId: 'app-session', cwd: '/tmp' }, h.writer, context);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(h.runtime.getState('app-session').turnId, null, 'the turn id is still uncertain');
    assert.equal(await h.runtime.abort('app-session', false), false);
    assert.equal(h.runtime.getState('app-session').phase, 'stopFailed');
    assert.equal(reads, 3, 'three bounded confirmation attempts, never a fabricated success');
    // Only the unanswered turn/start remains pending; no read retry is left behind.
    assert.equal(h.frames.filter((frame) => frame.method === 'thread/read').length, 3);
    assert.equal(h.runtime.getState('app-session').phase, 'stopFailed');
  } finally {
    h.reply({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } } });
    await running?.catch(() => {});
    await h.runtime.close();
    await h.transport.close();
  }
});

test('a retry already released by its timer cannot cross into a replacement process', async (t) => {
  const first = fakeProcess(43210);
  const replacement = fakeProcess(43211);
  const children = [first.child, replacement.child];
  const transport = new CodexAppServerTransport({ spawn: () => children.shift()!, timeoutMs: 100 });
  first.onFrame((frame) => {
    if (frame.id === undefined) return;
    if (frame.method === 'thread/read') first.reject(frame, emptyRolloutMessage());
    else first.reply({ id: frame.id, result: {} });
  });
  replacement.onFrame((frame) => { if (frame.id !== undefined) replacement.reply({ id: frame.id, result: {} }); });
  try {
    await transport.request('ping');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const stale = transport.request('thread/read', { threadId: 'old-thread' })
      .then(() => 'unexpected success', () => 'rejected');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(first.frames.filter((frame) => frame.method === 'thread/read').length, 1);
    // Resolve the backoff, then replace the process before its await continuation runs.
    t.mock.timers.tick(50);
    first.child.emit('exit', 1, null);
    const explicitFreshRequest = transport.request('ping');
    await explicitFreshRequest;
    assert.equal(await stale, 'rejected');
    assert.equal(replacement.frames.filter((frame) => frame.method === 'thread/read').length, 0);
  } finally {
    t.mock.timers.reset();
    await transport.close();
  }
});
