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
  StageLogBridge,
  StageLogMcpConfig,
  SessionRuntimeSettings,
} from '@/shared/index.js';

type PrepareInput = Parameters<StageLogBridge['prepareSession']>[0];

function harness() {
  const calls: Array<{ method: string; params: AnyRecord }> = [];
  let notify: (frame: CodexRpcFrame) => void = () => {};
  let nextTurn = 1;
  const rpc: CodexRpcClient = {
    instanceId: 'transport-instance',
    ensureInstanceId: () => 'transport-instance',
    get status() {
      return { running: true, pid: 1, startedAt: 1, pendingRequests: 0, launcherPath: null, cliVersion: '0.163.0' };
    },
    async request<T>(method: string, params: AnyRecord = {}) {
      calls.push({ method, params });
      switch (method) {
        case 'thread/start': case 'thread/resume': return { thread: { id: params.threadId ?? 'native-thread' } } as T;
        case 'thread/read': return { thread: { turns: [] } } as T;
        case 'thread/goal/get': return { goal: null } as T;
        case 'thread/unsubscribe': return { status: 'notLoaded' } as T;
        case 'turn/start': return { turn: { id: `turn-${nextTurn++}` } } as T;
        default: return {} as T;
      }
    },
    onNotification(listener) { notify = listener; return () => {}; },
    onRequest() { return () => {}; },
    onExit() { return () => {}; },
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

  const prepares: PrepareInput[] = [];
  const closedRuntimes: string[] = [];
  let residentConnection: StageLogMcpConfig | null = {
    url: 'http://127.0.0.1:3001/api/scheduler-mcp',
    headers: { Authorization: 'Bearer resident-token' },
  };
  const stageLogBridge: StageLogBridge = {
    async prepareSession(input) {
      prepares.push(input);
      return residentConnection;
    },
    closeRuntime(runtimeInstanceId) { closedRuntimes.push(runtimeInstanceId); },
  };
  runtime.setStageLogBridge(stageLogBridge);

  let workerConfig: Record<string, unknown> | null = {
    'mcp_servers.cloudcli_workers': { enabled: true, url: 'http://127.0.0.1:3001/api/worker-mcp', http_headers: { Authorization: 'Bearer worker-token' } },
  };
  const workerBridge: CodexWorkerBridge = {
    async prepareSession() { return workerConfig; },
    async activateSession() {},
    async stopSession() { return true; },
    async closeAppServer() {},
    async hasActiveWorkers() { return false; },
  };
  runtime.setWorkerBridge(workerBridge);

  return {
    runtime, calls, events, writer, context, prepares, closedRuntimes,
    setResidentConnection(value: StageLogMcpConfig | null) { residentConnection = value; },
    setWorkerConfig(value: Record<string, unknown> | null) { workerConfig = value; },
    event: (frame: CodexRpcFrame) => notify(frame),
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

test('a new thread carries the stage-log server next to the existing Worker server', async () => {
  const h = harness();
  const run = h.runtime.run('hello', { ...options, userTurn: true }, h.writer, h.context);
  await eventually(() => h.calls.some((call) => call.method === 'turn/start'));
  const start = h.calls.find((call) => call.method === 'thread/start')!;
  assert.deepEqual(start.params.config, {
    'mcp_servers.cloudcli_workers': {
      enabled: true, url: 'http://127.0.0.1:3001/api/worker-mcp', http_headers: { Authorization: 'Bearer worker-token' },
    },
    'mcp_servers.cloudcli_scheduler': {
      enabled: true,
      url: 'http://127.0.0.1:3001/api/scheduler-mcp',
      http_headers: { Authorization: 'Bearer resident-token' },
    },
  });
  assert.equal(h.prepares.length, 1);
  assert.equal(h.prepares[0].sessionId, 'session-1');
  assert.equal(h.prepares[0].projectPath, '/repo');
  assert.equal(h.prepares[0].provider, 'codex');
  assert.equal(h.prepares[0].userId, null);
  assert.match(String(h.prepares[0].runtimeInstanceId), /^codex-stage-log:[^:]+$/);
  // Logging never changes what the adapter advertises about Worker tools.
  assert.equal(h.runtime.getState('session-1').workerEnabled, true);
  h.event({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } } });
  await run;
  await h.runtime.close();
});

test('a resumed thread receives the resident server without changing its native id', async () => {
  const h = harness();
  const resumedContext = { ...h.context, resolveProviderSessionId: () => 'native-thread' };
  const run = h.runtime.run('hello again', { ...options, userTurn: true }, h.writer, resumedContext);
  await eventually(() => h.calls.some((call) => call.method === 'turn/start'));
  const resume = h.calls.find((call) => call.method === 'thread/resume')!;
  assert.equal(resume.params.threadId, 'native-thread');
  assert.deepEqual(resume.params.config['mcp_servers.cloudcli_scheduler'], {
    enabled: true,
    url: 'http://127.0.0.1:3001/api/scheduler-mcp',
    http_headers: { Authorization: 'Bearer resident-token' },
  });
  // Resume keeps the requested model and the user's Worker server untouched.
  assert.equal(resume.params.model, 'test-model');
  assert.ok(resume.params.config['mcp_servers.cloudcli_workers']);
  h.event({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } } });
  await run;
  const turnStart = h.calls.find((call) => call.method === 'turn/start')!;
  assert.equal(turnStart.params.threadId, 'native-thread');
  await h.runtime.close();
});

test('a declined resident config leaves the thread request exactly as before', async () => {
  const h = harness();
  h.setResidentConnection(null);
  const run = h.runtime.run('hello', { ...options, userTurn: true }, h.writer, h.context);
  await eventually(() => h.calls.some((call) => call.method === 'turn/start'));
  const start = h.calls.find((call) => call.method === 'thread/start')!;
  assert.deepEqual(start.params.config, {
    'mcp_servers.cloudcli_workers': {
      enabled: true, url: 'http://127.0.0.1:3001/api/worker-mcp', http_headers: { Authorization: 'Bearer worker-token' },
    },
  });
  assert.equal(h.runtime.getState('session-1').workerEnabled, true);
  h.event({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } } });
  await run;
  await h.runtime.close();
});

test('stage logging works while Worker tools are disabled', async () => {
  const h = harness();
  h.setWorkerConfig(null);
  const run = h.runtime.run('hello', { ...options, userTurn: true }, h.writer, h.context);
  await eventually(() => h.calls.some((call) => call.method === 'turn/start'));
  const start = h.calls.find((call) => call.method === 'thread/start')!;
  assert.deepEqual(Object.keys(start.params.config), ['mcp_servers.cloudcli_scheduler']);
  assert.equal(h.runtime.getState('session-1').workerEnabled, false);
  h.event({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } } });
  await run;
  await h.runtime.close();
});

test('neither bridge leaves the thread request without a config override', async () => {
  const h = harness();
  h.setWorkerConfig(null);
  h.setResidentConnection(null);
  const run = h.runtime.run('hello', { ...options, userTurn: true }, h.writer, h.context);
  await eventually(() => h.calls.some((call) => call.method === 'turn/start'));
  const start = h.calls.find((call) => call.method === 'thread/start')!;
  assert.equal('config' in start.params, false);
  h.event({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } } });
  await run;
  await h.runtime.close();
});

test('the runtime token is released only when the runtime is torn down', async () => {
  const h = harness();
  const run = h.runtime.run('hello', { ...options, userTurn: true }, h.writer, h.context);
  await eventually(() => h.calls.some((call) => call.method === 'turn/start'));
  h.event({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } } });
  await run;
  // An ordinary turn end and an explicit Stop are not runtime teardown.
  assert.equal(await h.runtime.abort('session-1'), true);
  assert.deepEqual(h.closedRuntimes, []);

  await h.runtime.close();
  assert.deepEqual(h.closedRuntimes, [String(h.prepares[0].runtimeInstanceId)]);
});

test('a failing resident bridge never blocks the turn', async () => {
  const h = harness();
  h.runtime.setStageLogBridge({
    async prepareSession() { throw new Error('host unavailable'); },
    closeRuntime() { throw new Error('host unavailable'); },
  });
  const run = h.runtime.run('hello', { ...options, userTurn: true }, h.writer, h.context);
  await eventually(() => h.calls.some((call) => call.method === 'turn/start'));
  const start = h.calls.find((call) => call.method === 'thread/start')!;
  assert.deepEqual(Object.keys(start.params.config), ['mcp_servers.cloudcli_workers']);
  h.event({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'turn-1', status: 'completed' } } });
  await run;
  assert.equal(h.events.some((event) => event.kind === 'error'), false);
  await h.runtime.close();
});
