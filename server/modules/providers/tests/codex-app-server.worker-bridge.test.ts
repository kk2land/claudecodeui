import assert from 'node:assert/strict';
import test from 'node:test';

import { CodexAppServerRuntime } from '@/modules/providers/list/codex/codex-app-server.runtime.js';
import type {
  AnyRecord,
  CodexRpcClient,
  CodexRpcFrame,
  CodexWorkerBridge,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
  SessionRuntimeSettings,
} from '@/shared/index.js';

function harness() {
  const calls: Array<{ method: string; params: AnyRecord }> = [];
  let notify: (frame: CodexRpcFrame) => void = () => {};
  let exit: (error: Error, instanceId?: string) => void = () => {};
  let nextTurn = 1;
  const rpc: CodexRpcClient = {
    instanceId: 'transport-instance',
    ensureInstanceId: () => 'transport-instance',
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
  const bridge: CodexWorkerBridge = {
    async prepareSession(input) {
      bridgeCalls.push(`prepare:${input.appServerInstanceId}:${input.sessionId}`);
      return prepareConfig;
    },
    async activateSession(sessionId) { bridgeCalls.push(`activate:${sessionId}`); },
    async stopSession(sessionId) { stoppedSessions.push(sessionId); return stopImpl(sessionId); },
    async closeAppServer(instanceId) { bridgeCalls.push(`close:${instanceId}`); },
  };
  runtime.setWorkerBridge(bridge);
  return {
    runtime, bridge, bridgeCalls, stoppedSessions, calls, events, writer, context, settingsDb,
    setPrepare(value: Record<string, unknown> | null) { prepareConfig = value; },
    setStopSession(impl: (sessionId: string) => Promise<boolean>) { stopImpl = impl; },
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
  assert.ok(h.bridgeCalls.includes('prepare:transport-instance:session-1'));
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

test('app-server exit closes exactly its connection generation', async () => {
  const h = harness();
  h.exit(new Error('app-server exited'), 'generation-7');
  await eventually(() => h.bridgeCalls.includes('close:generation-7'));
  await h.runtime.close();
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
