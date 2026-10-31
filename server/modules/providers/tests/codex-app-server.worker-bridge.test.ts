import assert from 'node:assert/strict';
import test from 'node:test';

import { CodexAppServerRuntime } from '@/modules/providers/list/codex/codex-app-server.runtime.js';
import { createCodexRuntimeRouter } from '@/modules/providers/list/codex/codex-runtime-router.provider.js';
import { AppError } from '@/shared/index.js';
import type {
  AnyRecord,
  CodexRpcClient,
  CodexRpcFrame,
  CodexWorkerBridge,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
  SessionRuntimeSettings,
} from '@/shared/index.js';

function harness(config: { keepaliveIntervalMs?: number } = {}) {
  const calls: Array<{ method: string; params: AnyRecord }> = [];
  let notify: (frame: CodexRpcFrame) => void = () => {};
  let exit: (error: Error, instanceId?: string) => void = () => {};
  let nextTurn = 1;
  let running = true;
  const rpc: CodexRpcClient = {
    instanceId: 'transport-instance',
    ensureInstanceId: () => 'transport-instance',
    get status() {
      return { running, pid: running ? 1 : null, startedAt: running ? 1 : null, pendingRequests: 0, launcherPath: null, cliVersion: '0.163.0' };
    },
    async request<T>(method: string, params: AnyRecord = {}) {
      calls.push({ method, params });
      switch (method) {
        case 'thread/start': case 'thread/resume': return { thread: { id: 'native-thread' } } as T;
        case 'thread/read': return { thread: { turns: [] } } as T;
        case 'thread/goal/get': return { goal: null } as T;
        case 'thread/unsubscribe': return { status: 'notLoaded' } as T;
        case 'turn/start': return { turn: { id: `turn-${nextTurn++}` } } as T;
        default: return {} as T;
      }
    },
    onNotification(listener) { notify = listener; return () => {}; },
    onRequest() { return () => {}; },
    onExit(listener) { exit = listener; return () => {}; },
  };
  const settings = new Map<string, SessionRuntimeSettings>();
  const settingsDb = {
    get: (id: string): SessionRuntimeSettings => settings.get(id) ?? { runtime: 'app-server' as const, mode: 'default' as const, queueHeld: false },
    update(id: string, patch: Partial<SessionRuntimeSettings>) {
      const value = { ...this.get(id), ...patch };
      settings.set(id, value);
      return value;
    },
    holdCodexAppServerQueues() {
      for (const [id, value] of settings) if (value.runtime === 'app-server') this.update(id, { queueHeld: true });
    },
  };
  const runtime = new CodexAppServerRuntime(rpc, settingsDb, 100, () => {}, async () => [], 30_000, {
    modelProviders: {
      list: async () => ({ defaultProvider: 'openai', hasCustomProviders: false, providers: [{ id: 'openai', name: 'OpenAI' }] }),
      models: async (provider: string) => ({ modelProvider: provider, models: ['test-model'], expiresAt: Date.now() + 60_000 }),
    },
    keepaliveIntervalMs: config.keepaliveIntervalMs,
  });
  const events: AnyRecord[] = [];
  const writer: ProviderRuntimeWriter = { send: (data) => events.push(data as AnyRecord), userId: null };
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ DEFAULT: 'test-model', OPTIONS: [] }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  };
  const bridgeCalls: string[] = [];
  let prepareConfig: Record<string, unknown> | null = {
    'mcp_servers.cloudcli_workers': { enabled: true, url: 'http://127.0.0.1:3001/api/worker-mcp' },
  };
  const stoppedSessions: string[] = [];
  let stopImpl: (sessionId: string) => Promise<boolean> = async () => true;
  let closeImpl: () => Promise<void> = async () => {};
  let activeWorkers: boolean | ((sessionId: string) => boolean) = false;
  const hasActiveWorkerChecks: string[] = [];
  const bridge: CodexWorkerBridge = {
    async prepareSession(input) {
      bridgeCalls.push(`prepare:${input.appServerInstanceId}:${input.sessionId}`);
      return prepareConfig;
    },
    async activateSession(sessionId) { bridgeCalls.push(`activate:${sessionId}`); },
    async stopSession(sessionId) { stoppedSessions.push(sessionId); return stopImpl(sessionId); },
    async closeAppServer(instanceId) { bridgeCalls.push(`close:${instanceId}`); await closeImpl(); },
    async hasActiveWorkers(sessionId) {
      hasActiveWorkerChecks.push(sessionId);
      return typeof activeWorkers === 'function' ? activeWorkers(sessionId) : activeWorkers;
    },
  };
  runtime.setWorkerBridge(bridge);
  return {
    runtime, bridge, bridgeCalls, stoppedSessions, calls, events, writer, context, settingsDb, hasActiveWorkerChecks,
    setPrepare(value: Record<string, unknown> | null) { prepareConfig = value; },
    setStopSession(impl: (sessionId: string) => Promise<boolean>) { stopImpl = impl; },
    setClose(impl: () => Promise<void>) { closeImpl = impl; },
    setActiveWorkers(value: boolean | ((sessionId: string) => boolean)) { activeWorkers = value; },
    setRunning(value: boolean) { running = value; },
    event: (frame: CodexRpcFrame) => notify(frame),
    exit: (error: Error, instanceId?: string) => exit(error, instanceId),
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(predicate(), 'condition was not reached');
}

const options = { sessionId: 'session-1', cwd: '/repo', projectPath: '/repo', model: 'test-model' };

test('a user turn prepares the thread config and activates the Worker owner', async () => {
  const h = harness();
  const run = h.runtime.run('hello', { ...options, userTurn: true }, h.writer, h.context);
  await eventually(() => h.calls.some((call) => call.method === 'turn/start'));
  const start = h.calls.find((call) => call.method === 'thread/start')!;
  assert.deepEqual(start.params.config, {
    'mcp_servers.cloudcli_workers': { enabled: true, url: 'http://127.0.0.1:3001/api/worker-mcp' },
  });
  assert.match(h.bridgeCalls.find((call) => call.startsWith('prepare:'))!, /^prepare:codex:[^:]+:session-1$/);
  assert.ok(h.bridgeCalls.includes('activate:session-1'));
  const stopping = h.runtime.abort('session-1');
  await new Promise((resolve) => setImmediate(resolve));
  h.event({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } } });
  await run;
  await stopping;
  await h.runtime.close();
});

test('a worker wake-up never clears a held queue', async () => {
  const h = harness();
  h.settingsDb.update('session-1', { queueHeld: true });
  await assert.rejects(
    h.runtime.run('wake', { ...options, workerWakeup: true }, h.writer, h.context),
    { code: 'CODEX_WORKER_WAKE_STOPPED' },
  );
  assert.equal(h.calls.some((call) => call.method === 'turn/start'), false);
  assert.equal(h.bridgeCalls.some((call) => call.startsWith('activate:')), false);
  await h.runtime.close();
});

test('Stop with no native session still cancels the session workers', async () => {
  const h = harness();
  assert.equal(await h.runtime.abort('session-1'), true);
  assert.deepEqual(h.stoppedSessions, ['session-1']);
});

test('idle proxy exit preserves Workers and their logical owner when a result resumes the native thread', async () => {
  const h = harness();
  const first = h.runtime.run('start Workers', { ...options, userTurn: true }, h.writer, h.context);
  await eventually(() => h.calls.some((call) => call.method === 'turn/start'));
  h.event({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } } });
  await first;
  const registration = h.bridgeCalls.find((call) => call.startsWith('prepare:'))!;

  h.exit(new AppError('Proxy idle timeout.', { code: 'CODEX_APP_SERVER_CLEAN_EXIT' }), 'old-proxy');
  assert.equal(h.bridgeCalls.some((call) => call.startsWith('close:')), false);
  assert.equal(h.runtime.getState('session-1').phase, 'idle');
  assert.equal(h.runtime.getState('session-1').error, undefined);
  assert.equal(h.runtime.getState('session-1').workerEnabled, true);
  assert.equal(h.settingsDb.get('session-1').queueHeld, false);

  const resumed = h.runtime.run('Worker result', { ...options, workerWakeup: true }, h.writer,
    { ...h.context, resolveProviderSessionId: () => 'native-thread' });
  await eventually(() => h.calls.filter((call) => call.method === 'turn/start').length === 2);
  assert.equal(h.calls.filter((call) => call.method === 'thread/resume').length, 1);
  assert.deepEqual(h.bridgeCalls.filter((call) => call.startsWith('prepare:')), [registration, registration]);
  assert.equal(h.bridgeCalls.filter((call) => call.startsWith('activate:')).length, 1);
  h.event({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-2', status: 'completed' } } });
  await resumed;
  await h.runtime.close();
  assert.equal(h.bridgeCalls.filter((call) => call.startsWith('close:')).length, 1);
});

test('exit during a native turn keeps the failure and queue hold without replaying input or cancelling Workers', async () => {
  const h = harness();
  const run = h.runtime.run('in flight', { ...options, userTurn: true }, h.writer, h.context);
  await eventually(() => h.calls.some((call) => call.method === 'turn/start'));
  h.exit(new AppError('Process exited.', { code: 'CODEX_APP_SERVER_CLEAN_EXIT' }));
  await run;
  assert.equal(h.runtime.getState('session-1').phase, 'failed');
  assert.equal(h.settingsDb.get('session-1').queueHeld, true);
  assert.equal(h.calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.equal(h.bridgeCalls.some((call) => call.startsWith('close:')), false);
  await h.runtime.close();
});

test('explicit process Stop still cancels Workers after idle exit without starting another proxy', async () => {
  const h = harness();
  const run = h.runtime.run('start Workers', { ...options, userTurn: true }, h.writer, h.context);
  await eventually(() => h.calls.some((call) => call.method === 'turn/start'));
  h.event({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } } });
  await run;
  h.exit(new AppError('Proxy idle timeout.', { code: 'CODEX_APP_SERVER_CLEAN_EXIT' }));
  const callsBeforeStop = h.calls.length;
  let finishCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
  h.setClose(() => cleanup);
  let stops = 0;
  const router = createCodexRuntimeRouter({ native: h.runtime, settings: h.settingsDb, stop: async () => { stops++; } });
  let confirmed = false;
  const stopping = router.control!('session-1', { action: 'stop-app-server' }, options, h.writer, h.context)
    .then(() => { confirmed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stops, 1);
  assert.equal(confirmed, false, 'process Stop waits for Worker cleanup even with no live proxy');
  assert.equal(h.calls.length, callsBeforeStop);
  assert.equal(h.settingsDb.get('session-1').queueHeld, true);
  assert.equal(h.bridgeCalls.filter((call) => call.startsWith('close:')).length, 1);
  finishCleanup();
  await stopping;
  await h.runtime.close();
});

test('explicit process Stop reports unconfirmed Worker cleanup and leaves the queue paused', async () => {
  const h = harness();
  h.setClose(async () => { throw new Error('Worker cleanup not confirmed'); });
  let stopped = false;
  const router = createCodexRuntimeRouter({
    native: h.runtime, settings: h.settingsDb, stop: async () => { stopped = true; },
  });
  await assert.rejects(router.control!('session-1', { action: 'stop-app-server' }, options, h.writer, h.context), /not confirmed/);
  assert.equal(stopped, true, 'Worker failure must not skip native process termination');
  assert.equal(h.settingsDb.get('session-1').queueHeld, true);
  // Runtime shutdown still tears down its own resources after a Worker error.
  await h.runtime.close();
  assert.equal(h.calls.length, 0);
});

for (const blockedAt of ['model', 'worker-registration']) test(`process Stop after idle exit cancels setup waiting for ${blockedAt}`, async () => {
  const h = harness();
  const first = h.runtime.run('start Workers', { ...options, userTurn: true }, h.writer, h.context);
  await eventually(() => h.calls.some((call) => call.method === 'turn/start'));
  h.event({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } } });
  await first;
  h.exit(new AppError('Proxy idle timeout.', { code: 'CODEX_APP_SERVER_CLEAN_EXIT' }));
  const before = h.calls.length;
  let release!: () => void;
  let blocked = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const context = { ...h.context, resolveProviderSessionId: () => 'native-thread',
    resolveResumeModel: async () => {
      if (blockedAt === 'model') { blocked = true; await gate; }
      return 'test-model';
    } };
  const prepare = h.bridge.prepareSession;
  h.bridge.prepareSession = async (input) => {
    if (blockedAt === 'worker-registration') { blocked = true; await gate; }
    return prepare(input);
  };
  const router = createCodexRuntimeRouter({ native: h.runtime, settings: h.settingsDb, stop: async () => {}, isStopping: () => false });
  const pending = router.run('do not restart after Stop', { ...options, userTurn: true }, h.writer, context);
  await eventually(() => blocked);
  await router.control!('session-1', { action: 'stop-app-server' }, options, h.writer, context);
  release();
  await eventually(() => h.events.some((event) => event.kind === 'complete' && event.aborted)
    || h.calls.slice(before).some((call) => call.method === 'turn/start'));
  const staleCalls = h.calls.slice(before);
  // Settle the buggy path too, so a regression reports an assertion instead of hanging.
  if (staleCalls.some((call) => call.method === 'turn/start')) {
    h.event({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-2', status: 'completed' } } });
  }
  await pending;
  await h.runtime.close();
  assert.deepEqual(staleCalls, [], 'no old initialization may spawn a proxy or send a turn after Stop');
  assert.equal(h.settingsDb.get('session-1').queueHeld, true);
});

test('runtime handoff stops the associated workers and still unsubscribes a known thread without a cached session', async () => {
  const h = harness();
  await h.runtime.releaseSession('session-1', 'native-thread');
  assert.deepEqual(h.stoppedSessions, ['session-1']);
  assert.equal(h.calls.some((call) => call.method === 'thread/unsubscribe' && call.params.threadId === 'native-thread'), true);
  await h.runtime.close();
});

test('Stop interrupts native work immediately and stays stopping until Worker cleanup finishes', { timeout: 10_000 }, async (t) => {
  const h = harness();
  let releaseWorker!: (value: boolean) => void;
  const workerCleanup = new Promise<boolean>((resolve) => { releaseWorker = resolve; });
  h.setStopSession(() => workerCleanup);
  const run = h.runtime.run('hello', { ...options, userTurn: true }, h.writer, h.context);
  await eventually(() => h.calls.some((call) => call.method === 'turn/start'));
  const stopping = h.runtime.abort('session-1');
  t.after(async () => {
    releaseWorker?.(true);
    await stopping;
    await h.runtime.close();
  });
  await eventually(() => h.calls.some((call) => call.method === 'turn/interrupt'));
  assert.ok(releaseWorker);
  // Native interruption was observed while Worker cleanup is still pending.
  h.event({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } } });
  await run;
  await eventually(() => h.calls.some((call) => call.method === 'thread/backgroundTerminals/clean'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.runtime.getState('session-1').phase, 'stopping');
  await assert.rejects(
    h.runtime.run('too early', { ...options, userTurn: true }, h.writer, {
      ...h.context,
      resolveProviderSessionId: () => 'native-thread',
    }),
    /The previous Codex stop has not been confirmed/,
  );
  assert.equal(h.calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.equal(h.bridgeCalls.filter((call) => call === 'activate:session-1').length, 1);
  releaseWorker(true);
  assert.equal(await stopping, true);
  assert.equal(h.runtime.getState('session-1').phase, 'idle');
});

test('an unconfirmed Worker cleanup makes Stop false even after native interruption succeeds', async () => {
  const h = harness();
  h.setStopSession(async () => false);
  const run = h.runtime.run('hello', { ...options, userTurn: true }, h.writer, h.context);
  await eventually(() => h.calls.some((call) => call.method === 'turn/start'));
  const stopping = h.runtime.abort('session-1');
  await eventually(() => h.calls.some((call) => call.method === 'turn/interrupt'));
  h.event({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } } });
  await run;
  assert.equal(await stopping, false);
  assert.equal(h.runtime.getState('session-1').phase, 'stopFailed');
  await h.runtime.close();
});

test('failed Worker cleanup blocks an uncached SDK handoff before unsubscribe', async () => {
  const h = harness();
  h.setStopSession(async () => false);
  await assert.rejects(
    h.runtime.releaseSession('session-1', 'native-thread'),
    /Could not stop the previous Worker cleanup/,
  );
  assert.equal(h.calls.some((call) => call.method === 'thread/unsubscribe'), false);
  await h.runtime.close();
});

test('a successful Worker config is reported on the session state', async () => {
  const h = harness();
  const run = h.runtime.run('hello', { ...options, userTurn: true }, h.writer, h.context);
  await eventually(() => h.calls.some((call) => call.method === 'turn/start'));
  assert.equal(h.runtime.getState('session-1').workerEnabled, true);
  h.event({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } } });
  await run;
  await h.runtime.close();
});

test('a missing Worker config never advertises Worker tools', async () => {
  const h = harness();
  h.setPrepare(null);
  const run = h.runtime.run('hello', { ...options, userTurn: true }, h.writer, h.context);
  await eventually(() => h.calls.some((call) => call.method === 'turn/start'));
  assert.equal(h.runtime.getState('session-1').workerEnabled, false);
  h.event({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } } });
  await run;
  await h.runtime.close();
});

test('a deferred Worker wake-up creates no native turn and no failed state', async () => {
  const h = harness();
  await assert.rejects(
    h.runtime.run('wake', {
      ...options,
      workerWakeup: true,
      deferTurn: () => false,
    }, h.writer, h.context),
    { code: 'WORKER_WAKE_DEFERRED' },
  );
  assert.equal(h.calls.some((call) => call.method === 'turn/start'), false);
  assert.equal(h.runtime.getState('session-1').phase, 'idle');
  assert.equal(h.events.some((event) => event.kind === 'error'), false);
  await h.runtime.close();
});

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test('thread/loaded/list keepalive runs only for this session while its Worker is active and the proxy is ready', async () => {
  const h = harness({ keepaliveIntervalMs: 20 });
  const run = h.runtime.run('start Workers', { ...options, userTurn: true }, h.writer, h.context);
  await eventually(() => h.calls.some((call) => call.method === 'turn/start'));
  h.event({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } } });
  await run;
  const loaded = () => h.calls.filter((call) => call.method === 'thread/loaded/list');
  const messagesAfterTurn = h.events.length;

  // A loaded Worker-enabled thread alone is not activity.
  await delay(60);
  assert.equal(loaded().length, 0);
  assert.equal(h.events.length, messagesAfterTurn, 'keepalive never publishes UI messages');

  h.setActiveWorkers((sessionId) => sessionId === 'session-1');
  await eventually(() => loaded().length > 0);
  assert.ok(h.hasActiveWorkerChecks.every((sessionId) => sessionId === 'session-1'));
  assert.deepEqual(loaded()[0].params, {});
  assert.equal(h.events.length, messagesAfterTurn);

  // Worker completion stops further proxy activity.
  h.setActiveWorkers(false);
  await delay(50);
  const settled = loaded().length;
  await delay(60);
  assert.equal(loaded().length, settled);

  // An exited proxy is never restarted merely by the timer.
  h.setActiveWorkers(true);
  h.setRunning(false);
  const beforeExit = loaded().length;
  await delay(60);
  assert.equal(loaded().length, beforeExit);

  await h.runtime.close();
  h.setRunning(true);
  h.setActiveWorkers(true);
  await delay(50);
  assert.equal(loaded().length, beforeExit, 'close releases the keepalive timer');
});

test('a persistent loaded thread resumes keepalive after Stop and a later user turn', async () => {
  const h = harness({ keepaliveIntervalMs: 20 });
  const first = h.runtime.run('start Workers', { ...options, userTurn: true }, h.writer, h.context);
  await eventually(() => h.calls.some((call) => call.method === 'turn/start'));
  h.event({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } } });
  await first;
  await h.runtime.abort('session-1');

  const loaded = () => h.calls.filter((call) => call.method === 'thread/loaded/list');
  const persistentContext = { ...h.context, resolveProviderSessionId: () => 'native-thread' };
  const next = h.runtime.run('after Stop', { ...options, userTurn: true }, h.writer, persistentContext);
  await eventually(() => h.calls.filter((call) => call.method === 'turn/start').length === 2);
  // No Worker is active yet: the restored timer still sends no keepalive.
  await delay(60);
  assert.equal(loaded().length, 0);

  h.setActiveWorkers(true);
  for (let index = 0; index < 100 && loaded().length === 0; index++) await delay(10);
  assert.ok(loaded().length > 0, 'a later Worker on the same loaded thread is kept alive');
  assert.equal(h.calls.filter((call) => call.method === 'thread/start').length, 1);
  assert.equal(h.calls.filter((call) => call.method === 'thread/resume').length, 0);

  h.event({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-2', status: 'completed' } } });
  await next;
  await h.runtime.close();
});

test('a loaded thread resumes keepalive after Stop and an explicit Goal action', async () => {
  const previousGoalSetting = process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
  process.env.CLOUDCLI_CODEX_GOAL_ENABLED = 'true';
  const h = harness({ keepaliveIntervalMs: 20 });
  try {
    const first = h.runtime.run('start Workers', { ...options, userTurn: true }, h.writer, h.context);
    await eventually(() => h.calls.some((call) => call.method === 'turn/start'));
    h.event({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } } });
    await first;
    await h.runtime.abort('session-1');

    const loaded = () => h.calls.filter((call) => call.method === 'thread/loaded/list');
    await h.runtime.control('session-1', { action: 'goal', operation: 'set', objective: 'continue the task' }, options, h.writer,
      { ...h.context, resolveProviderSessionId: () => 'native-thread' });
    await delay(60);
    assert.equal(loaded().length, 0);

    h.setActiveWorkers(true);
    for (let index = 0; index < 100 && loaded().length === 0; index++) await delay(10);
    assert.ok(loaded().length > 0, 'the Goal resume path restored the stopped keepalive timer');
    assert.equal(h.calls.filter((call) => call.method === 'thread/start').length, 1);
    assert.equal(h.calls.filter((call) => call.method === 'thread/resume').length, 0);
  } finally {
    await h.runtime.close();
    if (previousGoalSetting === undefined) delete process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
    else process.env.CLOUDCLI_CODEX_GOAL_ENABLED = previousGoalSetting;
  }
});

test('explicit process Stop discards an in-flight Worker activity query and releases keepalive', async () => {
  const h = harness({ keepaliveIntervalMs: 20 });
  let queryStarted = false;
  let releaseQuery!: (active: boolean) => void;
  h.bridge.hasActiveWorkers = () => {
    queryStarted = true;
    return new Promise<boolean>((resolve) => { releaseQuery = resolve; });
  };
  const run = h.runtime.run('start Workers', { ...options, userTurn: true }, h.writer, h.context);
  await eventually(() => h.calls.some((call) => call.method === 'turn/start'));
  h.event({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } } });
  await run;
  const messagesAfterTurn = h.events.length;
  const loaded = () => h.calls.filter((call) => call.method === 'thread/loaded/list');
  for (let index = 0; index < 100 && !queryStarted; index++) await delay(10);
  assert.equal(queryStarted, true, 'the keepalive tick reached the activity query');

  const router = createCodexRuntimeRouter({ native: h.runtime, settings: h.settingsDb, stop: async () => {}, isStopping: () => false });
  await router.control!('session-1', { action: 'stop-app-server' }, options, h.writer, h.context);
  assert.equal(h.bridgeCalls.filter((call) => call.startsWith('close:')).length, 1);
  assert.equal(h.settingsDb.get('session-1').queueHeld, true);

  // The old generation returns active=true only after Stop cleared the timer;
  // it must not send loaded/list, restart a proxy, or publish another message.
  releaseQuery(true);
  await delay(80);
  assert.equal(loaded().length, 0);
  assert.equal(h.calls.filter((call) => call.method === 'thread/start').length, 1);
  assert.equal(h.events.length, messagesAfterTurn);
  await h.runtime.close();
});
