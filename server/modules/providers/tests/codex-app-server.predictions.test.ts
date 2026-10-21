import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { CodexAppServerRuntime } from '@/modules/providers/list/codex/codex-app-server.runtime.js';
import { AppError } from '@/shared/index.js';
import type {
  AnyRecord,
  CodexRpcClient,
  CodexRpcFrame,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
  SessionRuntimeSettings,
} from '@/shared/index.js';

// Goal notifications are only adopted when the deployment opts into Goals, so
// the goal-continuation case below needs the same flag the runtime checks.
const originalGoalSetting = process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
beforeEach(() => { process.env.CLOUDCLI_CODEX_GOAL_ENABLED = 'true'; });
afterEach(() => {
  if (originalGoalSetting === undefined) delete process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
  else process.env.CLOUDCLI_CODEX_GOAL_ENABLED = originalGoalSetting;
});

/**
 * Scripted app-server double for the native composer-prediction lifecycle.
 *
 * The prediction RPC is deliberately separate from the turn RPCs: the runtime
 * must be able to receive its asynchronous result after the turn has already
 * completed and its writer was released.
 */
function harness(predictionTimeoutMs = 5_000) {
  const calls: Array<{ method: string; params: AnyRecord }> = [];
  let notify: (frame: CodexRpcFrame) => void = () => {};
  let exit: (error: Error) => void = () => {};
  let nativeId: string | null = null;
  let nextTurnId = 1;
  const handlers = new Map<string, (params: AnyRecord) => Promise<AnyRecord>>();
  const rpc: CodexRpcClient = {
    async request<T>(method: string, params: AnyRecord = {}) {
      calls.push({ method, params });
      if (handlers.has(method)) return await handlers.get(method)!(params) as T;
      switch (method) {
        case 'thread/start': case 'thread/resume': return { thread: { id: 'native-thread' } } as T;
        case 'thread/read': return { thread: { turns: [] } } as T;
        case 'thread/goal/get': return { goal: null } as T;
        case 'turn/start': return { turn: { id: `turn-${nextTurnId++}` } } as T;
        case 'thread/unsubscribe': return { status: 'notLoaded' } as T;
        default: return {} as T;
      }
    },
    onNotification(fn) { notify = fn; return () => {}; },
    onRequest() { return () => {}; },
    onExit(fn) { exit = fn; return () => {}; },
  };
  let settings: SessionRuntimeSettings = { runtime: 'app-server', mode: 'default', queueHeld: false };
  const settingsDb = {
    get: () => settings,
    update: (_: string, patch: Partial<SessionRuntimeSettings>) => { settings = { ...settings, ...patch }; return settings; },
    holdCodexAppServerQueues() { settings = { ...settings, queueHeld: true }; },
  };
  const runtime = new CodexAppServerRuntime(rpc, settingsDb, 5_000, () => {}, async () => [], predictionTimeoutMs);
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
  const event = (method: string, params: AnyRecord = {}) => notify({ method, params: { threadId: 'native-thread', ...params } });
  const finish = (id = 'turn-1', status = 'completed') => event('turn/completed', { turn: { id, status } });
  const predictions = () => calls.filter(({ method }) => method === 'thread/prediction/request');
  return {
    runtime, calls, handlers, events, event, finish, predictions, writer, context, options,
    run: (extra: AnyRecord = {}, text = 'hello') => runtime.run(text, { ...options, ...extra }, writer, context),
    state: () => runtime.getState('app-session'),
    predictionUpdated: (params: AnyRecord) => event('thread/prediction/updated', params),
    exit: (error: Error) => exit(error),
  };
}

async function eventually(predicate: () => boolean, description = 'expected state') {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(predicate(), `expected ${description}`);
}

async function runCompletedTurn(h: ReturnType<typeof harness>, extra: AnyRecord = {}) {
  const running = h.run(extra);
  await eventually(() => Boolean(h.state().turnId), 'the running turn');
  h.finish('turn-1');
  await running;
}

test('a completed opted-in turn requests the native prediction once and publishes an asynchronous result', async () => {
  const h = harness();
  await runCompletedTurn(h);

  assert.equal(h.predictions().length, 1);
  assert.deepEqual(h.predictions()[0].params, { threadId: 'native-thread', sourceTurnId: 'turn-1' });
  // The prediction never starts a turn, and the completed turn stays terminal.
  assert.equal(h.calls.filter(({ method }) => method === 'turn/start').length, 1);
  assert.equal(h.state().phase, 'idle');
  assert.deepEqual(h.state().prediction, { sourceTurnId: 'turn-1', status: 'pending' });

  h.predictionUpdated({ sourceTurnId: 'turn-1', result: { type: 'completed', text: 'Next, add a regression test.' } });
  assert.deepEqual(h.state().prediction, { sourceTurnId: 'turn-1', status: 'ready', text: 'Next, add a regression test.' });
  assert.equal(h.state().phase, 'idle');
  assert.equal(h.state().error, undefined);
  assert.equal(h.events.some((event) => event.kind === 'error'), false);
});

test('prediction requests require per-turn opt-in and an ordinary successful turn', async () => {
  const notOptedIn = harness();
  await runCompletedTurn(notOptedIn, { composerPredictions: false });
  assert.equal(notOptedIn.predictions().length, 0);

  const failed = harness();
  const failing = failed.run();
  await eventually(() => Boolean(failed.state().turnId), 'the running turn');
  failed.finish('turn-1', 'failed');
  await failing;
  assert.equal(failed.predictions().length, 0);

  const stopped = harness();
  const stopping = stopped.run();
  await eventually(() => Boolean(stopped.state().turnId), 'the running turn');
  void stopped.runtime.abort('app-session');
  await eventually(() => stopped.state().phase !== 'running', 'the stopping state');
  stopped.finish('turn-1', 'interrupted');
  await stopping;
  assert.equal(stopped.predictions().length, 0);

  const goal = harness();
  const active = goal.run();
  await eventually(() => Boolean(goal.state().turnId), 'the running turn');
  goal.event('thread/goal/updated', { goal: { threadId: 'native-thread', objective: 'finish', status: 'active' } });
  goal.finish('turn-1');
  await active;
  assert.equal(goal.predictions().length, 0);

  // These native turns end with status=completed, while the existing chat
  // completion contract explicitly marks their goal outcome unsuccessful.
  for (const status of ['blocked', 'usageLimited', 'budgetLimited']) {
    const limited = harness();
    const running = limited.run();
    await eventually(() => Boolean(limited.state().turnId), 'the running goal turn');
    limited.event('thread/goal/updated', { goal: { threadId: 'native-thread', objective: 'finish', status } });
    limited.finish('turn-1');
    await running;
    assert.equal(limited.events.find((event) => event.kind === 'complete')?.success, false);
    assert.equal(limited.predictions().length, 0, `${status} must not request a prediction`);
  }
});

test('empty, failed, rejected and timed-out results are unavailable without touching chat state', async () => {
  // The generated `ThreadPredictionUpdatedNotification` schema admits exactly
  // `{result:{type:'completed',text?:string|null}}` and `{result:{type:'failed'}}`.
  // An empty successful result is a legitimate "no suggestion", not a failure.
  for (const result of [
    { type: 'completed', text: null },
    { type: 'completed', text: '   ' },
    { type: 'completed' },
  ]) {
    const h = harness();
    await runCompletedTurn(h);
    h.predictionUpdated({ sourceTurnId: 'turn-1', result });
    assert.deepEqual(h.state().prediction, { sourceTurnId: 'turn-1', status: 'unavailable', reason: 'empty' });
    assert.equal(h.state().phase, 'idle');
    assert.equal(h.state().error, undefined);
    assert.equal(h.events.filter((event) => event.kind === 'error').length, 0);
    assert.equal(h.events.some((event) => event.kind === 'complete' && event.success === false), false);
  }
  for (const result of [{ type: 'failed' }, { type: 'unexpected' }, undefined]) {
    const h = harness();
    await runCompletedTurn(h);
    h.predictionUpdated({ sourceTurnId: 'turn-1', result });
    assert.deepEqual(h.state().prediction, { sourceTurnId: 'turn-1', status: 'unavailable', reason: 'failed' });
    assert.equal(h.state().error, undefined);
    assert.equal(h.events.filter((event) => event.kind === 'error').length, 0);
  }

  const rejected = harness();
  rejected.handlers.set('thread/prediction/request', async () => {
    throw new AppError('experimental API is disabled', { code: 'CODEX_APP_SERVER_REJECTED' });
  });
  await runCompletedTurn(rejected);
  await eventually(() => rejected.state().prediction?.status === 'unavailable', 'the rejected prediction');
  assert.equal(rejected.state().prediction?.reason, 'rejected');
  assert.equal(rejected.state().phase, 'idle');
  assert.equal(rejected.state().error, undefined);

  // A transport/timeout-class failure is not a rejection; the reason stays
  // classified so the UI can localize it without provider text.
  const requestFailed = harness();
  requestFailed.handlers.set('thread/prediction/request', async () => {
    throw new AppError('Codex app-server did not confirm thread/prediction/request.', { code: 'CODEX_APP_SERVER_TIMEOUT' });
  });
  await runCompletedTurn(requestFailed);
  await eventually(() => requestFailed.state().prediction?.status === 'unavailable', 'the failed prediction request');
  assert.equal(requestFailed.state().prediction?.reason, 'request_failed');
  assert.equal(requestFailed.state().error, undefined);

  const timedOut = harness(20);
  await runCompletedTurn(timedOut);
  await eventually(() => timedOut.state().prediction?.status === 'unavailable', 'the timed-out prediction');
  // A result that arrives after the deadline must not resurrect the suggestion.
  timedOut.predictionUpdated({ sourceTurnId: 'turn-1', result: { type: 'completed', text: 'Too late.' } });
  assert.deepEqual(timedOut.state().prediction, {
    sourceTurnId: 'turn-1', status: 'unavailable', reason: 'timeout', error: 'Prediction timed out.',
  });
  assert.equal(timedOut.state().phase, 'idle');
  assert.equal(timedOut.state().error, undefined);
});

test('child threads, replaced turns and stale source turns cannot write a prediction', async () => {
  const h = harness();
  await runCompletedTurn(h);

  // Another thread (for example a subagent) is not this session's prediction.
  h.predictionUpdated({ threadId: 'child-thread', sourceTurnId: 'turn-1', result: { type: 'completed', text: 'Child text.' } });
  // A previous turn's result is not this request.
  h.predictionUpdated({ sourceTurnId: 'turn-old', result: { type: 'completed', text: 'Old text.' } });
  assert.equal(h.state().prediction?.status, 'pending');

  h.predictionUpdated({ sourceTurnId: 'turn-1', result: { type: 'completed', text: 'Next message.' } });
  assert.equal(h.state().prediction?.text, 'Next message.');

  // Starting the next turn discards a ready suggestion from the previous one.
  const next = h.run();
  await eventually(() => Boolean(h.state().turnId), 'the next turn');
  assert.equal(h.state().prediction, undefined);
  h.finish('turn-2');
  await next;
  assert.deepEqual(h.state().prediction, { sourceTurnId: 'turn-2', status: 'pending' });

  // The first turn's late result must not overwrite the newer pending request.
  h.predictionUpdated({ sourceTurnId: 'turn-1', result: { type: 'completed', text: 'Late first turn.' } });
  assert.deepEqual(h.state().prediction, { sourceTurnId: 'turn-2', status: 'pending' });
});

test('stopping, replacing the session, process exit and close discard pending predictions', async () => {
  const stopped = harness();
  await runCompletedTurn(stopped);
  await stopped.runtime.abort('app-session');
  assert.equal(stopped.state().prediction, undefined);

  const replaced = harness();
  await runCompletedTurn(replaced);
  replaced.writer.setSessionId!('replacement-thread');
  const next = replaced.run();
  await eventually(() => Boolean(replaced.state().turnId), 'the replacement turn');
  assert.equal(replaced.state().prediction, undefined);
  replaced.finish('turn-2');
  await next;

  const exited = harness();
  await runCompletedTurn(exited);
  exited.exit(new AppError('Codex app-server was stopped.', { code: 'CODEX_APP_SERVER_STOPPED' }));
  assert.equal(exited.state().prediction, undefined);

  // Closing unsubscribes and clears every outstanding timer; a late notice for
  // the closed runtime is ignored rather than published to a dropped writer.
  const closed = harness(10);
  await runCompletedTurn(closed);
  await closed.runtime.close();
  const published = closed.events.length;
  closed.predictionUpdated({ sourceTurnId: 'turn-1', result: { type: 'completed', text: 'After close.' } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(closed.events.length, published);
});
