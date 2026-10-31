import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';

import { CodexComposerPredictions } from '@/modules/providers/list/codex/codex-composer-predictions.provider.js';
import type { AnyRecord, CodexRpcClient, CodexRpcFrame, CodexPredictionConfiguration } from '@/shared/index.js';

const CONFIG: CodexPredictionConfiguration = {
  isEnabled: true,
  unsupportedModels: [],
  sampleRate: 1,
  prompt: 'Suggest the next user message.',
  promptVersion: 'v1',
  predictionReasoningEffort: null,
};

/** Settles the microtask queue so `generate` resumes after an awaited RPC. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Deferred promise so tests can resolve RPCs out of band. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type HarnessOptions = {
  generation?: () => number;
  isLive?: () => boolean;
  deadlineMs?: number;
};

function harness(options: HarnessOptions = {}) {
  const calls: Array<{ method: string; params: AnyRecord }> = [];
  const inflight = new Map<string, ReturnType<typeof deferred<AnyRecord>>>();
  let notify: (frame: CodexRpcFrame) => void = () => {};
  let requestHandler: ((frame: CodexRpcFrame) => Promise<unknown>) | null = null;

  const rpc: CodexRpcClient = {
    request<T>(method: string, params: AnyRecord = {}) {
      calls.push({ method, params });
      const d = deferred<AnyRecord>();
      // Store by method+index so a second fork/turn call gets a distinct holder.
      const key = `${method}#${calls.filter((c) => c.method === method).length}`;
      inflight.set(key, d);
      return d.promise as Promise<T>;
    },
    onNotification(fn) { notify = fn; return () => {}; },
    onRequest(fn) { requestHandler = fn; return () => {}; },
    onExit() { return () => {}; },
  };

  const executor = new CodexComposerPredictions(
    rpc,
    options.isLive ?? (() => true),
    options.deadlineMs ?? 30_000,
    options.generation ?? (() => 0),
  );

  const event = (method: string, threadId: string, params: AnyRecord = {}) => notify({ method, params: { threadId, ...params } });

  return {
    calls, inflight, executor, event, requestHandler: () => requestHandler,
    /** Resolves the Nth request for a method. */
    resolve(method: string, n: number, value: AnyRecord) {
      const holders = [...inflight.entries()].filter(([k]) => k.startsWith(`${method}#`));
      holders[n - 1][1].resolve(value);
    },
    reject(method: string, n: number, error: Error) {
      const holders = [...inflight.entries()].filter(([k]) => k.startsWith(`${method}#`));
      holders[n - 1][1].reject(error);
    },
  };
}

const generate = (executor: CodexComposerPredictions, overrides: Partial<Parameters<CodexComposerPredictions['generate']>[0]> = {}) =>
  executor.generate({
    parentThreadId: 'parent',
    sourceTurnId: 'turn-1',
    config: CONFIG,
    model: 'gpt-5.4',
    effort: null,
    signal: new AbortController().signal,
    ...overrides,
  });

test('fork uses native prediction parameters without unsupported configuration overrides', async () => {
  const h = harness();
  const result = generate(h.executor);
  const fork = h.calls.find((c) => c.method === 'thread/fork')!;
  assert.deepEqual(fork.params, {
    threadId: 'parent',
    experimentalPredictionMode: true,
    ephemeral: true,
    excludeTurns: true,
    threadSource: 'composer_predictions',
  });
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  await tick();
  const turn = h.calls.find((c) => c.method === 'turn/start')!;
  assert.equal(turn.params.threadId, 'fork-1');
  assert.equal(turn.params.outputSchema, null);
  assert.equal(turn.params.turnTrigger, 'composer_predictions');
  assert.equal(typeof turn.params.clientUserMessageId, 'string');
  assert.deepEqual(turn.params.input, [{ type: 'text', text: `${CONFIG.prompt}\n\nReturn only JSON matching this schema: {"type":"object","properties":{"suggestion":{"type":["string","null"]}},"required":["suggestion"]}`, text_elements: [] }]);
  assert.deepEqual(turn.params.responsesapiClientMetadata, {
    prediction_source_thread_id: 'parent',
    prediction_source_turn_id: 'turn-1',
    prediction_trigger: 'live',
  });
  // No effort key when none is configured.
  assert.equal('effort' in turn.params, false);
  h.resolve('turn/start', 1, { turn: { id: 'pturn-1' } });
  h.event('turn/completed', 'fork-1', { turn: { id: 'pturn-1', status: 'completed' } });
  const outcome = await result;
  // No assistant text accumulated → empty suggestion.
  assert.equal(outcome.status, 'unavailable');
  assert.equal(outcome.reason, 'empty');
});

test('a valid JSON suggestion is parsed and returned ready', async () => {
  const h = harness();
  const result = generate(h.executor);
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  await tick();
  h.resolve('turn/start', 1, { turn: { id: 'pturn-1' } });
  await tick();
  h.event('item/agentMessage/delta', 'fork-1', { turnId: 'pturn-1', delta: '{"suggestion": ' });
  h.event('item/agentMessage/delta', 'fork-1', { turnId: 'pturn-1', delta: '"Write the README."}' });
  h.event('turn/completed', 'fork-1', { turn: { id: 'pturn-1', status: 'completed' } });
  const outcome = await result;
  assert.deepEqual(outcome, { status: 'ready', text: 'Write the README.' });
});

test('MCP isolation uses a native ephemeral fork with the parent model route and an empty server map', async () => {
  const h = harness();
  const result = generate(h.executor, { isolateMcp: true, modelProvider: 'parent-provider' });
  assert.deepEqual(h.calls[0].params, {
    threadId: 'parent',
    model: 'gpt-5.4',
    modelProvider: 'parent-provider',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    config: { mcp_servers: {} },
    ephemeral: true,
    excludeTurns: true,
    threadSource: 'composer_predictions',
  });
  h.resolve('thread/fork', 1, { thread: { id: 'isolated-fork' } });
  await tick();
  h.resolve('turn/start', 1, { turn: { id: 'prediction-turn' } });
  h.event('item/agentMessage/delta', 'isolated-fork', { turnId: 'prediction-turn', delta: '{"suggestion":"Next."}' });
  h.event('turn/completed', 'isolated-fork', { turn: { id: 'prediction-turn', status: 'completed' } });
  assert.deepEqual(await result, { status: 'ready', text: 'Next.' });
  assert.equal(h.calls.some((call) => call.method === 'thread/start'), false);
  assert.ok(h.calls.some((call) => call.method === 'thread/unsubscribe' && call.params.threadId === 'isolated-fork'));
});

test('null and malformed answers map to empty / failed', async () => {
  for (const [json, reason] of [['{"suggestion": null}', 'empty'], ['not json', 'failed'], ['{"other": 1}', 'failed']] as const) {
    const h = harness();
    const result = generate(h.executor);
    h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
    await tick();
    h.resolve('turn/start', 1, { turn: { id: 'pturn-1' } });
    await tick();
    h.event('item/completed', 'fork-1', { turnId: 'pturn-1', item: { type: 'agentMessage', text: json } });
    h.event('turn/completed', 'fork-1', { turn: { id: 'pturn-1', status: 'completed' } });
    const outcome = await result;
    assert.equal(outcome.status, 'unavailable');
    assert.equal(outcome.reason, reason);
  }
});

test('turn/completed before the start ACK still produces a ready result', async () => {
  const h = harness();
  const result = generate(h.executor);
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  await tick();
  // A turn id arrives via notification, then completion, before the RPC ACK.
  h.event('turn/started', 'fork-1', { turn: { id: 'pturn-1' } });
  h.event('item/agentMessage/delta', 'fork-1', { turnId: 'pturn-1', delta: '{"suggestion": "Hi."}' });
  h.event('turn/completed', 'fork-1', { turn: { id: 'pturn-1', status: 'completed' } });
  h.resolve('turn/start', 1, { turn: { id: 'pturn-1' } });
  const outcome = await result;
  assert.deepEqual(outcome, { status: 'ready', text: 'Hi.' });
});

test('known-turn id-less messages do not pollute accumulated text', async () => {
  const h = harness();
  const result = generate(h.executor);
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  await tick();
  h.resolve('turn/start', 1, { turn: { id: 'pturn-1' } });
  await tick();
  // Id-less delta after the turn id is known must be ignored.
  h.event('item/agentMessage/delta', 'fork-1', { delta: 'GARBAGE' });
  h.event('item/agentMessage/delta', 'fork-1', { turnId: 'pturn-1', delta: '{"suggestion": "OK"}' });
  h.event('turn/completed', 'fork-1', { turn: { id: 'pturn-1', status: 'completed' } });
  const outcome = await result;
  assert.deepEqual(outcome, { status: 'ready', text: 'OK' });
});

test('a late fork ACK after cancellation still unsubscribes and never starts a turn', async () => {
  const h = harness();
  const controller = new AbortController();
  const result = generate(h.executor, { signal: controller.signal });
  // Fork stays pending; cancel the run.
  controller.abort();
  await result;
  // Now the fork finally acknowledges after the cancellation.
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  await new Promise((r) => setTimeout(r, 5));
  // No turn/start was issued, and the fork was unsubscribed.
  assert.equal(h.calls.some((c) => c.method === 'turn/start'), false);
  assert.ok(h.calls.some((c) => c.method === 'thread/unsubscribe' && c.params.threadId === 'fork-1'));
});

test('a late turn ACK after cancellation interrupts then unsubscribes', async () => {
  const h = harness();
  const controller = new AbortController();
  const result = generate(h.executor, { signal: controller.signal });
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  await result;
  // Turn start finally acknowledges the turn id.
  h.resolve('turn/start', 1, { turn: { id: 'pturn-1' } });
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(h.calls.some((c) => c.method === 'turn/interrupt' && c.params.turnId === 'pturn-1'));
  assert.ok(h.calls.some((c) => c.method === 'thread/unsubscribe' && c.params.threadId === 'fork-1'));
});

test('a cancellation when the turn id is already known interrupts immediately', async () => {
  const h = harness();
  const controller = new AbortController();
  const result = generate(h.executor, { signal: controller.signal });
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  // Wait for the fork to resolve so the watch listener is installed.
  await new Promise((r) => setTimeout(r, 5));
  h.event('turn/started', 'fork-1', { turn: { id: 'pturn-1' } });
  await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  await result;
  assert.ok(h.calls.some((c) => c.method === 'turn/interrupt' && c.params.turnId === 'pturn-1'));
});

test('a hung unsubscribe does not delay the result', async () => {
  const h = harness();
  const result = generate(h.executor);
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  await new Promise((r) => setTimeout(r, 5));
  h.resolve('turn/start', 1, { turn: { id: 'pturn-1' } });
  await new Promise((r) => setTimeout(r, 5));
  h.event('turn/completed', 'fork-1', { turn: { id: 'pturn-1', status: 'completed' } });
  // The unsubscribe RPC never resolves; the result still settles promptly.
  const outcome = await Promise.race([
    result,
    new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 50)),
  ]);
  assert.notEqual(outcome, 'timeout');
});

test('close cancels a pending fork and its late ACK cleans up against the same epoch', async () => {
  let generation = 0;
  const h = harness({ generation: () => generation });
  const result = generate(h.executor);
  await h.executor.close();
  // Fork still pending at close; resolve it afterwards.
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.calls.some((c) => c.method === 'turn/start'), false);
  assert.ok(h.calls.some((c) => c.method === 'thread/unsubscribe' && c.params.threadId === 'fork-1'));
  const outcome = await result;
  assert.equal(outcome.status, 'unavailable');
});

test('an old-generation ACK never issues RPCs after the generation advances', async () => {
  let generation = 1;
  const h = harness({ generation: () => generation });
  const controller = new AbortController();
  const result = generate(h.executor, { signal: controller.signal });
  controller.abort();
  await result;
  // The connection exited and restarted: a new generation.
  generation = 2;
  const callsAfterGen = () => h.calls.length;
  const before = callsAfterGen();
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  await new Promise((r) => setTimeout(r, 5));
  // No RPC calls were added for the stale fork id.
  assert.equal(h.calls.length, before);
});

test('a non-terminal error interrupts the turn', async () => {
  const h = harness();
  const result = generate(h.executor);
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  await new Promise((r) => setTimeout(r, 5));
  h.resolve('turn/start', 1, { turn: { id: 'pturn-1' } });
  await new Promise((r) => setTimeout(r, 5));
  h.event('error', 'fork-1', { turnId: 'pturn-1', error: { message: 'boom' }, willRetry: false });
  const outcome = await result;
  assert.equal(outcome.status, 'unavailable');
  assert.equal(outcome.reason, 'failed');
  assert.ok(h.calls.some((c) => c.method === 'turn/interrupt' && c.params.turnId === 'pturn-1'));
});

test('a terminal notification settled before the start ACK does not wait for it', async () => {
  const h = harness();
  const result = generate(h.executor);
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  await new Promise((r) => setTimeout(r, 5));
  // Drive terminal via notification, leave the turn/start ACK pending.
  h.event('turn/started', 'fork-1', { turn: { id: 'pturn-1' } });
  h.event('item/agentMessage/delta', 'fork-1', { turnId: 'pturn-1', delta: '{"suggestion": "Fast."}' });
  h.event('turn/completed', 'fork-1', { turn: { id: 'pturn-1', status: 'completed' } });
  // Result must settle promptly even though turn/start never acknowledged yet.
  const outcome = await Promise.race([
    result,
    new Promise<{ status: 'timeout' }>((r) => setTimeout(() => r({ status: 'timeout' as const }), 50)),
  ]);
  assert.deepEqual(outcome, { status: 'ready', text: 'Fast.' });
  // A normally-completed turn must not be interrupted after the late ACK.
  const interruptsBefore = h.calls.filter((c) => c.method === 'turn/interrupt').length;
  h.resolve('turn/start', 1, { turn: { id: 'pturn-1' } });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.calls.filter((c) => c.method === 'turn/interrupt').length, interruptsBefore);
});

test('an error notification before the start ACK is not blocked by it', async () => {
  const h = harness();
  const result = generate(h.executor);
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  await new Promise((r) => setTimeout(r, 5));
  h.event('turn/started', 'fork-1', { turn: { id: 'pturn-1' } });
  h.event('error', 'fork-1', { turnId: 'pturn-1', error: { message: 'boom' }, willRetry: false });
  const outcome = await Promise.race([
    result,
    new Promise<{ status: 'timeout' }>((r) => setTimeout(() => r({ status: 'timeout' as const }), 50)),
  ]);
  assert.equal(outcome.status, 'unavailable');
  assert.equal(outcome.reason, 'failed');
  // The non-terminal error still interrupts.
  h.resolve('turn/start', 1, { turn: { id: 'pturn-1' } });
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(h.calls.some((c) => c.method === 'turn/interrupt' && c.params.turnId === 'pturn-1'));
});

test('a cancellation where interrupt ACK never settles still emits unsubscribe', async () => {
  const h = harness();
  const controller = new AbortController();
  const result = generate(h.executor, { signal: controller.signal });
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  await new Promise((r) => setTimeout(r, 5));
  h.event('turn/started', 'fork-1', { turn: { id: 'pturn-1' } });
  await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  await result;
  // interrupt is never resolved; unsubscribe must still be issued.
  assert.ok(h.calls.some((c) => c.method === 'turn/interrupt' && c.params.turnId === 'pturn-1'));
  assert.ok(h.calls.some((c) => c.method === 'thread/unsubscribe' && c.params.threadId === 'fork-1'));
});

test('close with a known thread whose cleanup ACKs both hang still returns promptly', async () => {
  const h = harness();
  const result = generate(h.executor);
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  await new Promise((r) => setTimeout(r, 5));
  h.event('turn/started', 'fork-1', { turn: { id: 'pturn-1' } });
  await new Promise((r) => setTimeout(r, 5));
  // interrupt and unsubscribe RPCs are never resolved; close must not await them.
  await assert.doesNotReject(async () => {
    await Promise.race([
      h.executor.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('close hung')), 50)),
    ]);
  });
  await result;
});

test('a stale-thread unsubscribe is not re-sent to a new connection after generation advance', async () => {
  let generation = 1;
  let live = true;
  const h = harness({ generation: () => generation, isLive: () => live });
  const controller = new AbortController();
  const result = generate(h.executor, { signal: controller.signal });
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  await new Promise((r) => setTimeout(r, 5));
  h.resolve('turn/start', 1, { turn: { id: 'pturn-1' } });
  await new Promise((r) => setTimeout(r, 5));
  // Result settles while unsubscribe is still pending.
  h.event('turn/completed', 'fork-1', { turn: { id: 'pturn-1', status: 'completed' } });
  await result;
  const after = h.calls.length;
  // The connection exits and a new one starts; close must use the thread's own
  // recorded epoch and never address the new connection with the old id.
  generation = 2;
  await h.executor.close();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.calls.length, after, 'close must not re-send a stale id to a new generation');
});

test('a late fork ACK arriving after a real 2-second window is still cleaned up', async () => {
  const h = harness();
  const controller = new AbortController();
  const result = generate(h.executor, { signal: controller.signal });
  controller.abort();
  await result;
  // Delay the fork acknowledgement beyond any short grace window.
  await new Promise((r) => setTimeout(r, 2100));
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.calls.some((c) => c.method === 'turn/start'), false);
  assert.ok(h.calls.some((c) => c.method === 'thread/unsubscribe' && c.params.threadId === 'fork-1'));
});

test('a start RPC failure after turn/started interrupts the known turn', async () => {
  const h = harness();
  const result = generate(h.executor);
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  await tick();
  h.event('turn/started', 'fork-1', { turn: { id: 'pturn-1' } });
  h.reject('turn/start', 1, new Error('connection request failed'));
  assert.deepEqual(await result, { status: 'unavailable', reason: 'request_failed' });
  assert.ok(h.calls.some((c) => c.method === 'turn/interrupt' && c.params.turnId === 'pturn-1'));
  assert.ok(h.calls.some((c) => c.method === 'thread/unsubscribe'));
});

test('a disposed run removes its caller abort listener', async () => {
  const h = harness();
  const controller = new AbortController();
  const result = generate(h.executor, { signal: controller.signal });
  h.resolve('thread/fork', 1, { thread: { id: 'fork-1' } });
  await new Promise((r) => setTimeout(r, 5));
  h.resolve('turn/start', 1, { turn: { id: 'pturn-1' } });
  await new Promise((r) => setTimeout(r, 5));
  h.event('turn/completed', 'fork-1', { turn: { id: 'pturn-1', status: 'completed' } });
  await result;
  const listeners = getEventListeners(controller.signal, 'abort');
  assert.equal(listeners.length, 0, 'a settled run must not leave an abort listener behind');
});
