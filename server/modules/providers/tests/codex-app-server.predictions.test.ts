import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { CodexAppServerRuntime } from '@/modules/providers/list/codex/codex-app-server.runtime.js';
import { CodexComposerPredictions } from '@/modules/providers/list/codex/codex-composer-predictions.provider.js';
import { AppError } from '@/shared/index.js';
import type {
  AnyRecord,
  CodexRpcClient,
  CodexRpcFrame,
  CodexPredictionConfigResult,
  CodexPredictionConfiguration,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
  SessionRuntimeSettings,
} from '@/shared/index.js';

const originalGoalSetting = process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
beforeEach(() => { process.env.CLOUDCLI_CODEX_GOAL_ENABLED = 'true'; });
afterEach(() => {
  if (originalGoalSetting === undefined) delete process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
  else process.env.CLOUDCLI_CODEX_GOAL_ENABLED = originalGoalSetting;
});

const CONFIG: CodexPredictionConfiguration = {
  isEnabled: true,
  unsupportedModels: [],
  sampleRate: 1,
  prompt: 'Suggest.',
  promptVersion: 'v1',
  predictionReasoningEffort: null,
};
const READY_CONFIG: CodexPredictionConfigResult = { status: 'ready', config: CONFIG };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Scripted app-server double plus a real prediction executor. The runtime forks
 * and runs the prediction turn through real `thread/fork`/`turn/start` RPCs, so
 * this test exercises the actual fork+turn event contract, not a mocked
 * prediction method.
 */
function harness(opts: {
  config?: () => CodexPredictionConfigResult | Promise<CodexPredictionConfigResult>;
  providerEligible?: (provider: string | null) => boolean;
  random?: () => number;
  predictionTimeoutMs?: number;
  cliVersion?: string | null;
  goal?: () => AnyRecord | null;
  goalSet?: Promise<AnyRecord>;
} = {}) {
  let goalState: AnyRecord | null = null;
  const calls: Array<{ method: string; params: AnyRecord }> = [];
  const inflight = new Map<string, ReturnType<typeof deferred<AnyRecord>>>();
  const listeners = new Set<(frame: CodexRpcFrame) => void>();
  const notify = (frame: CodexRpcFrame) => { for (const listener of listeners) listener(frame); };
  let requestHandler: (frame: CodexRpcFrame) => Promise<unknown> = async () => ({});
  let exit: (error: Error) => void = () => {};
  let nativeId: string | null = null;
  let nextTurnId = 1;

  const rpc: CodexRpcClient = {
    request<T>(method: string, params: AnyRecord = {}) {
      calls.push({ method, params });
      const known = new Set(['thread/start', 'thread/resume', 'turn/start', 'thread/fork', 'turn/interrupt', 'account/read']);
      if (known.has(method)) {
        const d = deferred<AnyRecord>();
        const key = `${method}#${calls.filter((c) => c.method === method).length}`;
        inflight.set(key, d);
        return d.promise as Promise<T>;
      }
      switch (method) {
        case 'thread/read': return Promise.resolve({ thread: { turns: [] } } as T);
        case 'thread/goal/get': return Promise.resolve({ goal: opts.goal ? opts.goal() : goalState } as T);
        case 'thread/goal/set': return (opts.goalSet ?? Promise.resolve({ goal: { ...goalState, ...params } })) as Promise<T>;
        case 'thread/unsubscribe': return Promise.resolve({ status: 'notLoaded' } as T);
        default: return Promise.resolve({} as T);
      }
    },
    onNotification(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    onRequest(fn) { requestHandler = fn; return () => {}; },
    onExit(fn) { exit = fn; return () => {}; },
  };

  const configProvider = {
    load: (input: { signal: AbortSignal; refreshCredentials: () => Promise<void> }) => Promise.resolve((opts.config ?? (async () => READY_CONFIG))()),
  };
  const predictions = new CodexComposerPredictions(rpc, () => true, 30_000, () => 0);

  let settings: SessionRuntimeSettings = { runtime: 'app-server', mode: 'default', queueHeld: false };
  const settingsDb = {
    get: () => settings,
    update: (_: string, patch: Partial<SessionRuntimeSettings>) => { settings = { ...settings, ...patch }; return settings; },
    holdCodexAppServerQueues() { settings = { ...settings, queueHeld: true }; },
  };

  const runtime = new CodexAppServerRuntime(
    rpc, settingsDb, 5_000, () => {}, async () => [],
    opts.predictionTimeoutMs ?? 5_000,
    {
      configProvider,
      predictions,
      providerEligible: opts.providerEligible ?? (() => true),
      random: opts.random ?? Math.random,
      cliVersion: () => ('cliVersion' in opts ? opts.cliVersion! : '0.163.0'),
      modelProviders: {
        list: async () => ({ defaultProvider: 'openai', hasCustomProviders: false, providers: [{ id: 'openai', name: 'OpenAI' }] }),
        models: async (modelProvider: string) => ({ modelProvider, models: ['test-model'], expiresAt: Date.now() + 60_000 }),
      },
    },
  );

  const events: AnyRecord[] = [];
  const writer: ProviderRuntimeWriter = {
    send: (data) => events.push(data as AnyRecord),
    setSessionId: (id) => { nativeId = id; },
    nextTurn: () => writer,
  };
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => nativeId,
    resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ DEFAULT: 'test-model', OPTIONS: [] }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  };
  const options = { sessionId: 'app-session', cwd: '/tmp', model: 'test-model', composerPredictions: true };

  const resolve = (method: string, n: number, value: AnyRecord) => {
    const holders = [...inflight.entries()].filter(([k]) => k.startsWith(`${method}#`));
    holders[n - 1][1].resolve(value);
  };
  const event = (method: string, params: AnyRecord = {}) => notify({ method, params: { threadId: 'native-thread', ...params } });
  /** Emits a notification on an arbitrary thread (the prediction fork). */
  const rawEvent = (method: string, threadId: string, params: AnyRecord = {}) => notify({ method, params: { threadId, ...params } });
  // Drive a normal parent turn to completion: resolve thread/start, then
  // turn/start, then emit the parent completed event.
  const setup = async (extra: AnyRecord = {}, status = 'completed', goalStatus?: string) => {
    const running = runtime.run('hello', { ...options, ...extra }, writer, context);
    // ensure() first awaits thread/start, then issue() awaits turn/start.
    await eventually(() => calls.some((c) => c.method === 'thread/start'), 'thread/start issued');
    resolve('thread/start', 1, { thread: { id: 'native-thread' }, model: 'test-model', modelProvider: 'openai' });
    await eventually(() => calls.some((c) => c.method === 'turn/start'), 'turn/start issued');
    resolve('turn/start', 1, { turn: { id: 'turn-1' } });
    await eventually(() => runtime.getState('app-session').turnId === 'turn-1', 'parent turn id');
    if (goalStatus) event('thread/goal/updated', { goal: { status: goalStatus } });
    event('turn/completed', { turn: { id: 'turn-1', status } });
    await running;
  };

  return {
    runtime, calls, inflight, events, resolve, event, rawEvent, requestHandler: () => requestHandler,
    options, writer, context, setup,
    state: () => runtime.getState('app-session'),
    exit: (error: Error) => exit(error),
    predictions: (method: string) => calls.filter((c) => c.method === method),
    setGoal: (goal: AnyRecord | null) => { goalState = goal; },
  };
}

async function eventually(predicate: () => boolean, description = 'expected state') {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(predicate(), `expected ${description}`);
}

test('a completed opted-in turn forks and runs a prediction turn, publishing the parsed suggestion', async () => {
  const h = harness();
  await h.setup();
  // The prediction is now pending; the fork was issued.
  await eventually(() => h.predictions('thread/fork').length >= 1, 'fork issued');
  const fork = h.predictions('thread/fork')[0];
  assert.deepEqual(fork.params, {
    threadId: 'native-thread', experimentalPredictionMode: true, ephemeral: true, excludeTurns: true, threadSource: 'composer_predictions',
  });
  // Resolve the fork, which allows the prediction turn/start to be issued.
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  await eventually(() => h.predictions('turn/start').some((c) => c.params.threadId === 'fork-1'), 'prediction turn/start');
  h.resolve('turn/start', 2, { turn: { id: 'pturn-1' } });
  await eventually(() => h.predictions('turn/start').some((c) => c.params.threadId === 'fork-1'), 'prediction turn started');
  h.rawEvent('item/agentMessage/delta', 'fork-1', { turnId: 'pturn-1', delta: '{"suggestion": "Next."}' });
  h.rawEvent('turn/completed', 'fork-1', { turn: { id: 'pturn-1', status: 'completed' } });
  await eventually(() => h.state().prediction?.status === 'ready', 'the ready prediction');
  assert.equal(h.state().prediction?.text, 'Next.');
  assert.equal(h.state().phase, 'idle');
  assert.equal(h.events.some((e) => e.kind === 'error'), false);
});

test('prediction requests require per-turn opt-in and an ordinary successful turn', async () => {
  const notOptedIn = harness();
  await notOptedIn.setup({ composerPredictions: false });
  assert.equal(notOptedIn.calls.some((c) => c.method === 'thread/fork'), false);
  for (const status of ['failed', 'interrupted']) {
    const h = harness();
    await h.setup({}, status);
    assert.equal(h.calls.some((c) => c.method === 'thread/fork'), false);
  }
  const goal = harness();
  await goal.setup({}, 'completed', 'active');
  assert.equal(goal.calls.some((c) => c.method === 'thread/fork'), false);
});

test('a Worker-enabled parent keeps its owner while predictions use an isolated ephemeral fork', async () => {
  let configCalls = 0;
  let ownerCalls = 0;
  const h = harness({ config: () => { configCalls++; return READY_CONFIG; } });
  h.runtime.setWorkerBridge({
    async prepareSession() {
      ownerCalls++;
      return { 'mcp_servers.cloudcli_workers': { enabled: true, url: 'http://localhost/worker-mcp' } };
    },
    async activateSession() {}, async stopSession() { return true; }, async closeAppServer() {},
  });
  await h.setup();
  await eventually(() => h.predictions('thread/fork').length === 1, 'isolated prediction fork');
  assert.equal(h.state().workerEnabled, true);
  assert.equal(configCalls, 1);
  assert.deepEqual(h.predictions('thread/fork')[0].params, {
    threadId: 'native-thread', model: 'test-model', modelProvider: 'openai',
    sandbox: 'read-only', approvalPolicy: 'never', config: { mcp_servers: {} },
    ephemeral: true, excludeTurns: true, threadSource: 'composer_predictions',
  });
  h.resolve('thread/fork', 1, { thread: { id: 'isolated-fork' } });
  await eventually(() => h.predictions('turn/start').some((call) => call.params.threadId === 'isolated-fork'));
  h.resolve('turn/start', 2, { turn: { id: 'prediction-turn' } });
  h.rawEvent('item/agentMessage/delta', 'isolated-fork', { turnId: 'prediction-turn', delta: '{"suggestion":"Next."}' });
  h.rawEvent('turn/completed', 'isolated-fork', { turn: { id: 'prediction-turn', status: 'completed' } });
  await eventually(() => h.state().prediction?.status === 'ready');
  assert.equal(h.state().prediction?.text, 'Next.');
  assert.equal(h.state().workerEnabled, true);
  assert.equal(ownerCalls, 1, 'only the parent registers Worker ownership');
  assert.equal(h.predictions('thread/start').length, 1);
  assert.equal(h.state().error, undefined);
});

test('plan mode and an ineligible provider never fork', async () => {
  const plan = harness();
  await plan.setup({ collaborationMode: 'plan' });
  assert.equal(plan.calls.some((c) => c.method === 'thread/fork'), false);

  const ineligible = harness({ providerEligible: () => false });
  await ineligible.setup();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ineligible.calls.some((c) => c.method === 'thread/fork'), false);
});

test('a disabled or failing config is reported config_unavailable/ineligible without a fork', async () => {
  const disabled = harness({ config: async () => ({ status: 'ready', config: { ...CONFIG, isEnabled: false } }) });
  await disabled.setup();
  await eventually(() => disabled.state().prediction?.status === 'unavailable', 'disabled config settles');
  assert.equal(disabled.state().prediction?.reason, 'ineligible');
  assert.equal(disabled.calls.some((c) => c.method === 'thread/fork'), false);

  const unavailable = harness({ config: async () => ({ status: 'unavailable', reason: 'config_unavailable' }) });
  await unavailable.setup();
  await eventually(() => unavailable.state().prediction?.status === 'unavailable', 'unavailable config settles');
  assert.equal(unavailable.state().prediction?.reason, 'config_unavailable');
});

test('a sampling miss is reported as empty, not ineligible', async () => {
  const h = harness({ random: () => 0.99, config: async () => ({ status: 'ready', config: { ...CONFIG, sampleRate: 0.5 } }) });
  await h.setup();
  await eventually(() => h.state().prediction?.status === 'unavailable', 'sampling miss settles');
  assert.equal(h.state().prediction?.reason, 'empty');
  assert.equal(h.calls.some((c) => c.method === 'thread/fork'), false);
});

test('a config that hangs is still bounded by the overall deadline as a timeout', async () => {
  const h = harness({
    predictionTimeoutMs: 30,
    config: async () => new Promise<CodexPredictionConfigResult>(() => { /* never settles */ }),
  });
  await h.setup();
  await eventually(() => h.state().prediction?.status === 'unavailable', 'the timed-out prediction');
  assert.equal(h.state().prediction?.reason, 'timeout');
});

test('parent transcript never receives temporary-thread events', async () => {
  const h = harness();
  await h.setup();
  await eventually(() => h.predictions('thread/fork').length >= 1, 'fork issued');
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  await eventually(() => h.predictions('turn/start').some((c) => c.params.threadId === 'fork-1'), 'prediction turn issued');
  const completeBefore = h.events.filter((e) => e.kind === 'complete').length;
  // A temporary-thread agent message/usage/completion must not reach the
  // parent transcript, budget or complete channel. The prediction settles into
  // the parent's `prediction` state (a codex_state publish), but its text,
  // tool usage and completion must never surface as chat content.
  h.rawEvent('item/agentMessage/delta', 'fork-1', { turnId: 'pturn-1', delta: 'not parent text' });
  h.rawEvent('thread/tokenUsage/updated', 'fork-1', { tokenUsage: { total: { totalTokens: 999, inputTokens: 500, outputTokens: 499, modelContextWindow: 1000 } } });
  h.rawEvent('turn/completed', 'fork-1', { turn: { id: 'pturn-1', status: 'completed' } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.events.some((e) => (e.tokenBudget as AnyRecord | undefined)?.used === 999), false, 'fork usage must not reach the parent budget');
  assert.equal(h.events.filter((e) => e.kind === 'complete').length, completeBefore, 'fork completion must not reach the parent');
  assert.equal(h.events.some((e) => typeof e.text === 'string' && e.text.includes('not parent text')), false, 'fork text must not reach the parent');
});

test('session capability gate treats old, pre-release and unknown builds as unsupported', async () => {
  for (const cliVersion of [null, '0.162.1', '0.163.0-alpha.11', 'unknown']) {
    const h = harness({ cliVersion });
    // getState lazily computes predictionSupported without starting a fork.
    const state = h.state();
    assert.equal(state.predictionSupported, false, `unsupported for ${String(cliVersion)}`);
  }
  const supported = harness({ cliVersion: '0.163.0' });
  assert.equal(supported.state().predictionSupported, true);

  // An unknown build must never silently fall back to a plain turn even when a
  // user opted in.
  const unknown = harness({ cliVersion: null });
  await unknown.setup();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(unknown.calls.some((c) => c.method === 'thread/fork'), false);
});

test('stop and exit clear a pending prediction and ignore a late fork acknowledgement', async () => {
  const stopped = harness();
  await stopped.setup();
  await stopped.runtime.abort('app-session');
  assert.equal(stopped.state().prediction, undefined);
  stopped.resolve('thread/fork', 1, { thread: { id: 'late-stopped-fork' } });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(stopped.calls.some((c) => c.method === 'turn/start' && c.params.threadId === 'late-stopped-fork'), false);

  const exited = harness();
  await exited.setup();
  exited.exit(new AppError('Codex app-server was stopped.', { code: 'CODEX_APP_SERVER_STOPPED' }));
  assert.equal(exited.state().prediction, undefined);
});

test('a new turn, runtime handoff and close invalidate pending predictions', async () => {
  for (const action of ['new-turn', 'release', 'close']) {
    const h = harness();
    await h.setup();
    await eventually(() => h.predictions('thread/fork').length === 1);
    if (action === 'new-turn') h.event('turn/started', { turn: { id: 'new-parent-turn' } });
    else if (action === 'release') await h.runtime.releaseSession('app-session', 'native-thread');
    else await h.runtime.close();
    assert.equal(h.state().prediction, undefined, action);
    h.resolve('thread/fork', 1, { thread: { id: `late-${action}` } });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(h.calls.some((c) => c.method === 'turn/start' && c.params.threadId === `late-${action}`), false, action);
    assert.equal(h.state().prediction, undefined, action);
  }
});

test('reverse requests from a prediction thread are refused per-method and never reach the UI', async () => {
  const h = harness();
  await h.setup();
  await eventually(() => h.predictions('thread/fork').length >= 1, 'fork issued');
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  await eventually(() => h.predictions('turn/start').some((c) => c.params.threadId === 'fork-1'), 'prediction turn start issued');
  const handler = h.requestHandler();
  const decision = await handler({ method: 'item/commandExecution/requestApproval', id: 1, params: { threadId: 'fork-1', turnId: 'pturn-1' } });
  assert.deepEqual(decision, { decision: 'cancel' });
  const perms = await handler({ method: 'item/permissions/requestApproval', id: 2, params: { threadId: 'fork-1', turnId: 'pturn-1' } });
  assert.deepEqual(perms, { permissions: {}, scope: 'turn' });
  const answers = await handler({ method: 'item/tool/requestUserInput', id: 3, params: { threadId: 'fork-1', turnId: 'pturn-1' } });
  assert.deepEqual(answers, { answers: {} });
  await assert.rejects(handler({ method: 'unknown/rpc', id: 4, params: { threadId: 'fork-1' } }));
  // No permission_request or user-input question was surfaced to the UI.
  assert.equal(h.events.some((e) => e.kind === 'permission_request'), false);
  assert.equal(h.events.some((e) => e.kind === 'question'), false);
});

test('switching to Plan while config is pending cancels the prediction and never forks', async () => {
  const pending = deferred<CodexPredictionConfigResult>();
  const h = harness({ config: () => pending.promise });
  await h.setup();
  assert.equal(h.state().prediction?.status, 'pending');
  // The user switches to Plan while the remote config is still loading.
  await h.runtime.control('app-session', { action: 'mode', mode: 'plan' }, h.options, h.writer, h.context);
  assert.equal(h.state().prediction, undefined, 'a Plan switch must retire the pending prediction');
  pending.resolve(READY_CONFIG);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.calls.some((c) => c.method === 'thread/fork'), false, 'no fork after losing eligibility');
  assert.equal(h.state().prediction, undefined, 'no suggestion may appear under Plan');
});

test('a native Goal turning active while config is pending cancels the prediction and never forks', async () => {
  const pending = deferred<CodexPredictionConfigResult>();
  const h = harness({ config: () => pending.promise });
  await h.setup();
  assert.equal(h.state().prediction?.status, 'pending');
  h.event('thread/goal/updated', { goal: { status: 'active', objective: 'finish' } });
  assert.equal(h.state().prediction, undefined, 'an active Goal must retire the pending prediction');
  pending.resolve(READY_CONFIG);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.calls.some((c) => c.method === 'thread/fork'), false, 'no fork under an active Goal');
});

test('a ready suggestion is cleared when the user switches to Plan', async () => {
  const h = harness();
  await h.setup();
  await eventually(() => h.predictions('thread/fork').length === 1, 'fork issued');
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  await eventually(() => h.predictions('turn/start').some((c) => c.params.threadId === 'fork-1'), 'prediction turn/start');
  h.resolve('turn/start', 2, { turn: { id: 'pturn-1' } });
  h.rawEvent('item/agentMessage/delta', 'fork-1', { turnId: 'pturn-1', delta: '{"suggestion": "Plan."}' });
  h.rawEvent('turn/completed', 'fork-1', { turn: { id: 'pturn-1', status: 'completed' } });
  await eventually(() => h.state().prediction?.status === 'ready', 'the ready prediction');
  await h.runtime.control('app-session', { action: 'mode', mode: 'plan' }, h.options, h.writer, h.context);
  assert.equal(h.state().prediction, undefined, 'Plan must never show an old suggestion');
});

test('switching back to default after Plan does not resurrect a retained prediction', async () => {
  const pending = deferred<CodexPredictionConfigResult>();
  const h = harness({ config: () => pending.promise });
  await h.setup();
  await h.runtime.control('app-session', { action: 'mode', mode: 'plan' }, h.options, h.writer, h.context);
  await h.runtime.control('app-session', { action: 'mode', mode: 'default' }, h.options, h.writer, h.context);
  pending.resolve(READY_CONFIG);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.calls.some((c) => c.method === 'thread/fork'), false, 'the retired prediction never resumes');
  assert.equal(h.state().prediction, undefined);
});

test('a goal resume that activates while config is pending clears the prediction and never forks', async () => {
  const pending = deferred<CodexPredictionConfigResult>();
  const goalSet = deferred<AnyRecord>();
  const goal = { status: 'paused', objective: 'finish', tokensUsed: 0, tokenBudget: 1000, timeUsedSeconds: 0 };
  const h = harness({ config: () => pending.promise, goalSet: goalSet.promise });
  await h.setup();
  assert.equal(h.state().prediction?.status, 'pending');
  h.setGoal(goal);
  await h.runtime.control('app-session', { action: 'goal', operation: 'get' }, h.options, h.writer, h.context);
  assert.equal(h.state().prediction?.status, 'pending');
  // Keep the native Goal RPC pending while the prediction configuration arrives.
  const resuming = h.runtime.control('app-session', { action: 'goal', operation: 'resume' }, h.options, h.writer, h.context);
  await eventually(() => h.calls.some((c) => c.method === 'thread/goal/set'), 'Goal activation RPC issued');
  assert.equal(h.state().phase, 'starting');
  assert.equal(h.state().prediction, undefined);
  pending.resolve(READY_CONFIG);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.calls.some((c) => c.method === 'thread/fork'), false, 'no fork while Goal activation is pending');
  goalSet.resolve({ goal: { ...goal, status: 'active' } });
  await resuming;
  assert.equal(h.state().goal?.status, 'active');
  assert.equal(h.calls.some((c) => c.method === 'thread/fork'), false, 'no fork after a goal resume');
  assert.equal(h.state().prediction, undefined, 'the old prediction is cleared');
});

test('goal/get reporting active (no notification) clears a ready prediction', async () => {
  const h = harness();
  await h.setup();
  await eventually(() => h.predictions('thread/fork').length === 1, 'fork issued');
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  await eventually(() => h.predictions('turn/start').some((c) => c.params.threadId === 'fork-1'), 'prediction turn/start');
  h.resolve('turn/start', 2, { turn: { id: 'pturn-1' } });
  h.rawEvent('item/agentMessage/delta', 'fork-1', { turnId: 'pturn-1', delta: '{"suggestion": "Old."}' });
  h.rawEvent('turn/completed', 'fork-1', { turn: { id: 'pturn-1', status: 'completed' } });
  await eventually(() => h.state().prediction?.status === 'ready', 'the ready prediction');

  // goal/get is authoritative: an active goal retires the ready suggestion.
  h.setGoal({ status: 'active', objective: 'x', tokensUsed: 0, tokenBudget: null, timeUsedSeconds: 0 });
  await h.runtime.control('app-session', { action: 'goal', operation: 'get' }, h.options, h.writer, h.context);
  assert.equal(h.state().prediction, undefined, 'active goal clears the ready prediction');
});

test('a goal read reporting paused cannot resurrect an already-cleared ready prediction', async () => {
  const h = harness();
  await h.setup();
  await eventually(() => h.predictions('thread/fork').length === 1, 'fork issued');
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  await eventually(() => h.predictions('turn/start').some((c) => c.params.threadId === 'fork-1'), 'prediction turn/start');
  h.resolve('turn/start', 2, { turn: { id: 'pturn-1' } });
  h.rawEvent('item/agentMessage/delta', 'fork-1', { turnId: 'pturn-1', delta: '{"suggestion": "Old."}' });
  h.rawEvent('turn/completed', 'fork-1', { turn: { id: 'pturn-1', status: 'completed' } });
  await eventually(() => h.state().prediction?.status === 'ready', 'the ready prediction');
  await h.runtime.control('app-session', { action: 'mode', mode: 'plan' }, h.options, h.writer, h.context);
  assert.equal(h.state().prediction, undefined);
  await h.runtime.control('app-session', { action: 'mode', mode: 'default' }, h.options, h.writer, h.context);
  h.setGoal({ status: 'paused', objective: 'finish', tokensUsed: 0, tokenBudget: null, timeUsedSeconds: 0 });
  await h.runtime.control('app-session', { action: 'goal', operation: 'get' }, h.options, h.writer, h.context);
  assert.equal(h.state().goal?.status, 'paused');
  assert.equal(h.state().prediction, undefined, 'a paused goal read must not revive the old suggestion');
});
