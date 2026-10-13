import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { CodexAppServerRuntime } from '@/modules/providers/list/codex/codex-app-server.runtime.js';
import { createCodexRuntimeRouter } from '@/modules/providers/list/codex/codex-runtime-router.provider.js';
import { AppError } from '@/shared/index.js';
import type { AnyRecord, CodexRpcClient, CodexRpcFrame, NormalizedMessage, ProviderRuntimeContext, ProviderRuntimeWriter, SessionRuntimeSettings } from '@/shared/index.js';

const originalGoalSetting = process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
beforeEach(() => { process.env.CLOUDCLI_CODEX_GOAL_ENABLED = 'true'; });
afterEach(() => {
  if (originalGoalSetting === undefined) delete process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
  else process.env.CLOUDCLI_CODEX_GOAL_ENABLED = originalGoalSetting;
});

function harness(timeout = 100) {
  const calls: Array<{ method: string; params: AnyRecord }> = [];
  let notify: (frame: CodexRpcFrame) => void = () => {};
  let request: (frame: CodexRpcFrame) => Promise<unknown> = async () => ({});
  let exit: (error: Error) => void = () => {};
  let nativeId: string | null = null;
  let goal: AnyRecord | null = null;
  let nextTurnId = 1;
  const handlers = new Map<string, (params: AnyRecord) => Promise<AnyRecord>>();
  const rpc: CodexRpcClient = {
    async request<T>(method: string, params: AnyRecord = {}) {
      calls.push({ method, params });
      if (handlers.has(method)) return await handlers.get(method)!(params) as T;
      switch (method) {
        case 'thread/start': case 'thread/resume': return { thread: { id: 'native-thread' } } as T;
        case 'thread/read': return { thread: { turns: [] } } as T;
        case 'thread/goal/get': return { goal } as T;
        case 'thread/goal/set': goal = { threadId: 'native-thread', objective: 'goal', tokensUsed: 0, tokenBudget: null, timeUsedSeconds: 0, ...goal, ...params }; return { goal } as T;
        case 'thread/goal/clear': goal = null; return {} as T;
        case 'turn/start': return { turn: { id: `turn-${nextTurnId++}` } } as T;
        case 'thread/unsubscribe': return { status: 'notLoaded' } as T;
        default: return {} as T;
      }
    },
    onNotification(fn) { notify = fn; return () => {}; },
    onRequest(fn) { request = fn; return () => {}; },
    onExit(fn) { exit = fn; return () => {}; },
  };
  const settings = new Map<string, SessionRuntimeSettings>();
  const accepted: string[] = [];
  const storedMessages: NormalizedMessage[] = [];
  const historyReads: string[] = [];
  const settingsDb = {
    get: (id: string): SessionRuntimeSettings => settings.get(id) ?? { runtime: 'app-server', mode: 'default', queueHeld: false },
    update(id: string, patch: Partial<SessionRuntimeSettings>) {
      const value = { ...this.get(id), ...patch };
      settings.set(id, value);
      return value;
    },
    holdCodexAppServerQueues() {
      for (const [id, value] of settings) if (value.runtime === 'app-server') this.update(id, { queueHeld: true });
    },
  };
  const runtime = new CodexAppServerRuntime(rpc, settingsDb, timeout, (_, id) => accepted.push(id), async (sessionId) => {
    historyReads.push(sessionId);
    return storedMessages;
  });
  const events: AnyRecord[] = [];
  let writerNumber = 1;
  const writer: ProviderRuntimeWriter = { send: (data) => events.push({ ...data as AnyRecord, writer: 1 }), setSessionId: (id) => { nativeId = id; }, nextTurn: () => {
    const current = ++writerNumber;
    return { ...writer, send: (data) => events.push({ ...data as AnyRecord, writer: current }) };
  } };
  const context: ProviderRuntimeContext = { resolveProviderSessionId: () => nativeId, resolveResumeModel: async () => 'test-model', getProviderModels: async () => ({ DEFAULT: 'test-model', OPTIONS: [] }), normalizeMessage: () => [], isProviderInstalled: async () => true };
  const options = { sessionId: 'app-session', cwd: '/tmp', model: 'test-model', effort: 'high' };
  const event = (method: string, params: AnyRecord = {}) => notify({ method, params: { threadId: 'native-thread', ...params } });
  const finish = (id = 'turn-1', status = 'completed') => event('turn/completed', { turn: { id, status } });
  return { runtime, calls, handlers, events, event, finish, request: (frame: CodexRpcFrame) => request(frame), exit: (error: Error) => exit(error), accepted,
    options, writer, context, settingsDb, storedMessages, historyReads, settings: () => settingsDb.get('app-session'),
    control: (action: Parameters<CodexAppServerRuntime['control']>[1]) => runtime.control('app-session', action, options, writer, context),
    run: (text = 'hello', extra: AnyRecord = {}) => runtime.run(text, { ...options, ...extra }, writer, context) };
}

async function eventually(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 1)); }
  assert.ok(predicate(), 'expected state was never reached');
}

test('disabled Goals reject activation before any native call, while Plan and normal turns still work', async () => {
  delete process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
  const h = harness();
  for (const operation of ['set', 'resume'] as const) {
    await assert.rejects(h.control({ action: 'goal', operation, objective: 'disabled' }), { code: 'CODEX_GOAL_DISABLED' });
  }
  assert.equal(h.calls.length, 0);
  await h.control({ action: 'mode', mode: 'plan' });
  const running = h.run();
  await eventually(() => Boolean(h.runtime.getState('app-session').turnId));
  assert.equal(h.calls.find((call) => call.method === 'turn/start')?.params.collaborationMode.mode, 'plan');
  assert.equal(h.calls.some((call) => call.method.startsWith('thread/goal/')), false);
  h.event('thread/goal/updated', { goal: { objective: 'old persisted goal', status: 'active' } });
  assert.equal(h.runtime.getState('app-session').goal, null);
  h.finish();
  await running;
  assert.equal(h.runtime.listActiveSessions().length, 0);
});

test('restoring an existing thread confirms persisted steer receipts with Goals disabled', async () => {
  delete process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
  const h = harness();
  h.writer.setSessionId!('native-thread');
  h.handlers.set('thread/read', async () => ({ thread: { turns: [
    { items: [{ type: 'userMessage', clientId: 'lost-steer-receipt' }] },
  ] } }));

  await h.control({ action: 'state' });
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.accepted, []);

  await h.control({ action: 'goal', operation: 'get' });
  assert.deepEqual(h.calls.map(({ method }) => method), ['thread/resume', 'thread/read']);
  assert.equal(h.calls[0].params.excludeTurns, true);
  assert.equal('historyMode' in h.calls[0].params, false);
  assert.deepEqual(h.accepted, ['lost-steer-receipt']);
  assert.deepEqual(h.historyReads, []);
  assert.equal(h.runtime.getState('app-session').goal, null);
  assert.equal(h.runtime.getState('app-session').phase, 'idle');
});

test('restoring a thread without list_turns uses persisted receipts and allows another native send', async () => {
  delete process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
  const h = harness();
  h.writer.setSessionId!('native-thread');
  h.handlers.set('thread/resume', async (params) => {
    if (!params.excludeTurns) throw new AppError('list_turns is not supported yet', { code: 'CODEX_APP_SERVER_REJECTED' });
    return { thread: { id: 'native-thread' } };
  });
  h.handlers.set('thread/read', async () => {
    throw new AppError('list_turns is not supported yet', { code: 'CODEX_APP_SERVER_REJECTED' });
  });
  h.storedMessages.push({
    id: 'received-steer', clientMessageId: 'received-steer', kind: 'text', role: 'user',
    provider: 'codex', sessionId: 'app-session', timestamp: '2026-10-13T00:00:00.000Z', content: 'continue',
  }, {
    id: 'legacy-user-id', kind: 'text', role: 'user', provider: 'codex', sessionId: 'app-session',
    timestamp: '2026-10-13T00:00:00.000Z', content: 'continue',
  });

  const restored = await h.control({ action: 'goal', operation: 'get' });
  assert.equal(restored.phase, 'idle');
  assert.deepEqual(h.accepted, ['received-steer']);
  assert.deepEqual(h.historyReads, ['app-session']);
  assert.equal(h.calls.some(({ method }) => method === 'thread/start'), false);

  const running = h.run('next prompt');
  await eventually(() => Boolean(h.runtime.getState('app-session').turnId));
  assert.equal(h.calls.find(({ method }) => method === 'turn/start')?.params.threadId, 'native-thread');
  h.finish();
  await running;
});

test('unsupported history restoration preserves the running turn and never confirms missing receipts', async () => {
  const h = harness();
  const running = h.run();
  await eventually(() => Boolean(h.runtime.getState('app-session').turnId));
  h.handlers.set('thread/read', async () => {
    throw new AppError('list_turns is not supported yet', { code: 'CODEX_APP_SERVER_REJECTED' });
  });

  const restored = await h.control({ action: 'goal', operation: 'get' });
  assert.equal(restored.phase, 'running');
  assert.equal(restored.turnId, 'turn-1');
  assert.deepEqual(h.accepted, []);
  assert.equal(h.events.some((event) => event.kind === 'complete'), false);
  h.finish();
  await running;
});

test('history restoration still reports unrelated RPC failures', async () => {
  const h = harness();
  h.writer.setSessionId!('native-thread');
  h.handlers.set('thread/read', async () => {
    throw new AppError('Unable to read the thread', { code: 'CODEX_APP_SERVER_REJECTED' });
  });

  await assert.rejects(h.control({ action: 'goal', operation: 'get' }), /Unable to read the thread/);
  assert.deepEqual(h.historyReads, []);
  assert.deepEqual(h.accepted, []);
});

test('stored history never substitutes for native confirmation of an uncertain stop', async () => {
  const h = harness();
  h.handlers.set('turn/start', async () => {
    throw new AppError('Start acknowledgement timed out', { code: 'CODEX_APP_SERVER_TIMEOUT' });
  });
  h.handlers.set('thread/read', async () => {
    throw new AppError('list_turns is not supported yet', { code: 'CODEX_APP_SERVER_REJECTED' });
  });
  const running = h.run();
  await eventually(() => h.runtime.getState('app-session').phase === 'stopFailed');

  assert.equal(await h.runtime.abort('app-session'), false);
  assert.equal(h.runtime.getState('app-session').phase, 'stopFailed');
  assert.deepEqual(h.historyReads, []);
  assert.equal(h.events.some((event) => event.kind === 'complete'), false);
  h.finish('turn-1', 'interrupted');
  await running;
});

test('native turn uses independent Plan/permission settings and stable message identity', async () => {
  const h = harness();
  const running = h.run('design a page', { collaborationMode: 'plan', permissionMode: 'acceptEdits', clientMessageId: 'client-1' });
  await eventually(() => h.runtime.getState('app-session').turnId === 'turn-1');
  assert.equal(h.calls.find((call) => call.method === 'thread/start')?.params.historyMode, 'legacy');
  const start = h.calls.find((call) => call.method === 'turn/start')!.params;
  assert.equal(start.collaborationMode.mode, 'plan');
  assert.equal(start.collaborationMode.settings.model, 'test-model');
  assert.equal(start.approvalPolicy, 'never');
  assert.equal(start.sandboxPolicy.type, 'workspaceWrite');
  assert.equal(start.clientUserMessageId, 'client-1');
  h.event('item/started', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'item-1', text: '' } });
  h.event('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'item-1', delta: 'one' });
  h.event('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'item-1', delta: ' two' });
  assert.equal(h.events.filter((event) => event.kind === 'text').at(-1)?.content, 'one two');
  assert.equal(new Set(h.events.filter((event) => event.kind === 'text').map((event) => event.id)).size, 1);
  h.finish(); await running;
  assert.equal(h.events.filter((event) => event.kind === 'complete').length, 1);
});

test('steer binds the active turn and user echo confirms delivery', async () => {
  const h = harness(); const running = h.run();
  await eventually(() => Boolean(h.runtime.getState('app-session').turnId));
  await h.control({ action: 'steer', expectedTurnId: 'turn-1', requestId: 'receipt-1', content: 'also test it', attachments: [] });
  assert.equal(h.calls.find((call) => call.method === 'turn/steer')?.params.clientUserMessageId, 'receipt-1');
  h.event('item/completed', { turnId: 'turn-1', item: { type: 'userMessage', id: 'u1', clientId: 'receipt-1', content: [{ type: 'text', text: 'also test it' }] } });
  assert.deepEqual(h.accepted, ['receipt-1']);
  assert.equal(h.events.find((event) => event.role === 'user')?.id, 'receipt-1');
  h.finish(); await running;
  await assert.rejects(h.control({ action: 'steer', expectedTurnId: 'turn-1', requestId: 'receipt-2', content: 'late', attachments: [] }), /ended or is stopping/);
  assert.equal(h.calls.filter((call) => call.method === 'turn/steer').length, 1);
});

test('stop pauses the goal, holds queue, then waits for native terminal confirmation', async () => {
  const h = harness(); const running = h.run();
  await eventually(() => Boolean(h.runtime.getState('app-session').turnId));
  await h.control({ action: 'goal', operation: 'set', objective: 'finish' });
  let stopped = false;
  const stopping = h.runtime.abort('app-session').then((ok) => { stopped = ok; });
  await eventually(() => h.calls.some((call) => call.method === 'turn/interrupt'));
  assert.equal(stopped, false);
  assert.equal(h.settings().queueHeld, true);
  assert.equal(h.runtime.getState('app-session').goal?.status, 'paused');
  assert.equal(h.runtime.getState('app-session').phase, 'stopping');
  assert.equal(h.events.filter((event) => event.kind === 'complete').length, 0);
  h.finish('turn-1', 'interrupted');
  await stopping; await running;
  assert.equal(stopped, true);
  assert.equal(h.runtime.getState('app-session').phase, 'idle');
  assert.ok(h.calls.some((call) => call.method === 'thread/backgroundTerminals/clean'));
});

test('a timed-out stop remains uncertain and can be confirmed by retry', async () => {
  const h = harness(15); const running = h.run();
  await eventually(() => Boolean(h.runtime.getState('app-session').turnId));
  assert.equal(await h.runtime.abort('app-session'), false);
  assert.equal(h.runtime.getState('app-session').phase, 'stopFailed');
  assert.equal(h.events.filter((event) => event.kind === 'complete').length, 0);
  await assert.rejects(h.control({ action: 'steer', expectedTurnId: 'turn-1', requestId: 'late', content: 'late', attachments: [] }));
  h.finish('turn-1', 'interrupted'); await running;
  assert.equal(await h.runtime.abort('app-session'), true);
});

test('native goal continuations receive a new writer without redundant turn/start', async () => {
  const h = harness();
  await h.control({ action: 'goal', operation: 'set', objective: 'complete it', tokenBudget: 1000 });
  assert.equal(h.calls.filter((call) => call.method === 'turn/start').length, 0);
  h.event('turn/started', { turn: { id: 'auto-1' } });
  h.finish('auto-1');
  h.event('turn/started', { turn: { id: 'auto-2' } });
  h.event('thread/goal/updated', { goal: { objective: 'complete it', status: 'complete', tokensUsed: 100 } });
  h.finish('auto-2');
  const complete = h.events.filter((event) => event.kind === 'complete');
  assert.deepEqual(complete.map((event) => event.writer), [2, 3]);
  assert.deepEqual(complete.map((event) => event.goalActive), [true, false]);
  h.finish('auto-1');
  assert.equal(h.events.filter((event) => event.kind === 'complete').length, 2);
});

test('a Plan goal is saved paused until explicitly resumed in execution mode', async () => {
  const h = harness();
  await h.control({ action: 'mode', mode: 'plan' });
  await h.control({ action: 'goal', operation: 'set', objective: 'plan only' });
  assert.equal(h.runtime.getState('app-session').goal?.status, 'paused');
  await assert.rejects(h.control({ action: 'goal', operation: 'resume' }), /execution mode/);
  await h.control({ action: 'mode', mode: 'default' });
  await h.control({ action: 'goal', operation: 'resume' });
  assert.equal(h.runtime.getState('app-session').goal?.status, 'active');
});

test('native questions preserve answers and reject stale or incomplete submissions', async () => {
  const h = harness(); const running = h.run();
  await eventually(() => Boolean(h.runtime.getState('app-session').turnId));
  const answer = h.request({ id: 'server-rpc-1', method: 'item/tool/requestUserInput', params: { threadId: 'native-thread', turnId: 'turn-1', isBlocking: false,
    questions: [{ id: 'q', question: 'Choose', header: 'Choice', isOther: true, isSecret: false, options: [{ label: 'A', description: 'first' }] }] } });
  const q = h.runtime.getState('app-session').questions[0];
  assert.equal(q.isBlocking, false);
  await assert.rejects(h.control({ action: 'answer', requestId: q.requestId, answers: {} }), /every question/);
  await h.control({ action: 'answer', requestId: q.requestId, answers: { q: { answers: ['custom answer'] } } });
  assert.deepEqual(await answer, { answers: { q: { answers: ['custom answer'] } } });
  await assert.rejects(h.control({ action: 'answer', requestId: q.requestId, answers: { q: { answers: ['late'] } } }), /already been resolved/);
  h.finish(); await running;
});

test('a terminal event arriving before turn/start ack cannot complete the next goal turn', async () => {
  const h = harness(); let acknowledge!: (value: AnyRecord) => void;
  h.handlers.set('turn/start', () => new Promise((resolve) => { acknowledge = resolve; }));
  const running = h.run(); await eventually(() => Boolean(acknowledge));
  h.event('turn/started', { turn: { id: 'turn-1' } }); h.finish();
  h.event('turn/started', { turn: { id: 'turn-2' } });
  acknowledge({ turn: { id: 'turn-1' } }); await running;
  assert.equal(h.runtime.getState('app-session').turnId, 'turn-2');
  assert.equal(h.events.filter((event) => event.kind === 'complete').length, 1);
  h.finish('turn-2');
});

test('stop waits for owned subagents without touching unrelated threads', async () => {
  const h = harness(); const running = h.run();
  await eventually(() => Boolean(h.runtime.getState('app-session').turnId));
  h.event('thread/started', { thread: { id: 'child-1', parentThreadId: 'native-thread' } });
  h.event('thread/started', { thread: { id: 'unrelated', parentThreadId: 'someone-else' } });
  h.handlers.set('thread/read', async (params) => ({ thread: { turns: params.threadId === 'child-1' ? [{ id: 'child-turn', status: 'inProgress' }] : [] } }));
  let stopped = false;
  const stopping = h.runtime.abort('app-session').then((ok) => { stopped = ok; });
  await eventually(() => h.calls.some((call) => call.method === 'turn/interrupt'));
  h.finish('turn-1', 'interrupted'); await running;
  await eventually(() => h.calls.some((call) => call.method === 'turn/interrupt' && call.params.threadId === 'child-1'));
  assert.equal(stopped, false);
  h.event('turn/completed', { threadId: 'child-1', turn: { id: 'child-turn', status: 'interrupted' } });
  await stopping;
  assert.equal(stopped, true);
  assert.ok(!h.calls.some((call) => call.params.threadId === 'unrelated'));
});

test('late native auto-turns after a goal-gap stop are interrupted and reconciled back to idle', async () => {
  const h = harness();
  await h.control({ action: 'goal', operation: 'set', objective: 'finish' });
  assert.equal(await h.runtime.abort('app-session'), true);
  h.event('turn/started', { turn: { id: 'late-auto' } });
  await eventually(() => h.calls.some((call) => call.method === 'turn/interrupt' && call.params.turnId === 'late-auto'));
  assert.equal(h.runtime.getState('app-session').phase, 'stopping');
  h.finish('late-auto', 'interrupted');
  await eventually(() => h.runtime.getState('app-session').phase === 'idle');
});

test('stop during turn/start preserves intent until the native id arrives', async () => {
  const h = harness(); let acknowledge!: (value: AnyRecord) => void;
  h.handlers.set('turn/start', () => new Promise((resolve) => { acknowledge = resolve; }));
  const running = h.run(); await eventually(() => Boolean(acknowledge));
  const stopping = h.runtime.abort('app-session');
  acknowledge({ turn: { id: 'turn-1' } });
  await eventually(() => h.calls.some((call) => call.method === 'turn/interrupt' && call.params.turnId === 'turn-1'));
  h.finish('turn-1', 'interrupted');
  assert.equal(await stopping, true); await running;
});

test('pausing a blocked goal persists paused, and exhausted budgets stay enforced after pause', async () => {
  const h = harness();
  await h.control({ action: 'goal', operation: 'set', objective: 'finish', tokenBudget: 20 });
  h.event('thread/goal/updated', { goal: { threadId: 'native-thread', objective: 'finish', status: 'blocked', tokenBudget: 20, tokensUsed: 20 } });
  await h.control({ action: 'goal', operation: 'pause' });
  assert.equal(h.calls.at(-2)?.method, 'thread/goal/set');
  h.event('thread/goal/updated', { goal: { threadId: 'native-thread', objective: 'finish', status: 'paused', tokenBudget: 20, tokensUsed: 20 } });
  await assert.rejects(h.control({ action: 'goal', operation: 'resume' }), /Increase the goal budget/);
});

test('process exit fails the turn once and leaves an explicit recoverable failure snapshot', async () => {
  const h = harness(); const running = h.run();
  await eventually(() => Boolean(h.runtime.getState('app-session').turnId));
  h.exit(new Error('native process exited'));
  await running;
  assert.equal(h.events.filter((event) => event.kind === 'complete').length, 1);
  assert.equal(h.runtime.getState('app-session').phase, 'failed');
  assert.equal(h.settings().queueHeld, true);
  assert.match(h.runtime.getState('app-session').error ?? '', /native process exited/);
});


test('Stop waits for an in-flight goal activation and cancels an older queued resume', async () => {
  const h = harness(500);
  let activate!: () => void;
  h.handlers.set('thread/goal/set', async (params) => {
    if (params.status === 'active') await new Promise<void>((resolve) => { activate = resolve; });
    return { goal: { threadId: 'native-thread', objective: 'goal', status: params.status, tokensUsed: 0, tokenBudget: null, timeUsedSeconds: 0 } };
  });
  const setting = h.control({ action: 'goal', operation: 'set', objective: 'goal' });
  await eventually(() => Boolean(activate));
  const resume = h.control({ action: 'goal', operation: 'resume' });
  const rejected = assert.rejects(resume, /cancelled by Stop/);
  let stopped = false;
  const stop = h.runtime.abort('app-session').then((result) => { stopped = result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  activate();
  await Promise.all([setting, rejected, stop]);
  assert.equal(stopped, true);
  assert.equal(h.runtime.getState('app-session').goal?.status, 'paused');
  assert.equal(h.calls.filter((call) => call.method === 'thread/goal/set' && call.params.status === 'active').length, 1);
});

test('replacing an idle thread cleans the previous thread before resuming its fork', async () => {
  const h = harness();
  await h.control({ action: 'goal', operation: 'set', objective: 'first goal' });
  h.context.resolveProviderSessionId = () => 'fork-thread';
  h.handlers.set('thread/resume', async () => ({ thread: { id: 'fork-thread' } }));
  await h.control({ action: 'goal', operation: 'get' });
  const cleanup = h.calls.findIndex((call) => call.method === 'thread/backgroundTerminals/clean' && call.params.threadId === 'native-thread');
  const resume = h.calls.findIndex((call) => call.method === 'thread/resume');
  assert.ok(cleanup >= 0 && cleanup < resume);
  assert.equal(h.runtime.getState('app-session').goal?.status, 'paused');
});

test('setting and resuming a goal apply the current permissions before native activation', async () => {
  const h = harness();
  const first = h.run('first', { permissionMode: 'bypassPermissions' });
  await eventually(() => Boolean(h.runtime.getState('app-session').turnId));
  h.finish(); await first;
  await h.control({ action: 'mode', mode: 'plan' });
  await h.runtime.control('app-session', { action: 'goal', operation: 'set', objective: 'finish' }, { ...h.options, permissionMode: 'default' }, h.writer, h.context);
  let update = h.calls.filter((call) => call.method === 'thread/settings/update').at(-1)!.params;
  assert.equal(update.approvalPolicy, 'on-request');
  assert.equal(update.sandboxPolicy.type, 'workspaceWrite');
  assert.equal(update.sandboxPolicy.networkAccess, false);
  assert.deepEqual(update.sandboxPolicy.writableRoots, ['/tmp']);
  assert.equal(update.collaborationMode.mode, 'plan');
  await h.control({ action: 'mode', mode: 'default' });
  await h.runtime.control('app-session', { action: 'goal', operation: 'resume' }, { ...h.options, permissionMode: 'acceptEdits' }, h.writer, h.context);
  update = h.calls.filter((call) => call.method === 'thread/settings/update').at(-1)!.params;
  assert.equal(update.approvalPolicy, 'never');
  assert.equal(update.sandboxPolicy.type, 'workspaceWrite');
  assert.deepEqual(h.calls.slice(-2).map((call) => call.method), ['thread/settings/update', 'thread/goal/set']);
});

for (const resumed of [false, true]) {
  test(`Stop during thread/${resumed ? 'resume' : 'start'} cancels that submission and permits a later explicit send`, async () => {
    const h = harness();
    if (resumed) h.context.resolveProviderSessionId = () => 'native-thread';
    let acknowledge!: (result: AnyRecord) => void;
    h.handlers.set(resumed ? 'thread/resume' : 'thread/start', () => new Promise((resolve) => { acknowledge = resolve; }));
    const running = h.run();
    await eventually(() => Boolean(acknowledge));
    const stopping = h.runtime.abort('app-session');
    acknowledge({ thread: { id: 'native-thread' } });
    assert.equal(await stopping, true);
    await running;
    assert.equal(h.calls.filter((call) => call.method === 'turn/start').length, 0);
    assert.equal(h.runtime.getState('app-session').phase, 'idle');
    assert.equal(h.events.at(-1)?.aborted, true);
    const next = h.run('explicit new submission');
    await eventually(() => Boolean(h.runtime.getState('app-session').turnId));
    h.finish(); await next;
    assert.equal(h.calls.filter((call) => call.method === 'turn/start').length, 1);
  });
}

test('Stop before thread creation leaves no unusable cached session', async () => {
  const h = harness();
  let resolveModel!: (model: string) => void;
  h.context.resolveResumeModel = () => new Promise((resolve) => { resolveModel = resolve; });
  const running = h.run();
  await eventually(() => Boolean(resolveModel));
  const stopping = h.runtime.abort('app-session');
  resolveModel('test-model');
  assert.equal(await stopping, true); await running;
  assert.equal(h.calls.length, 0);
  h.context.resolveResumeModel = async () => 'test-model';
  const next = h.run('try again');
  await eventually(() => Boolean(h.runtime.getState('app-session').turnId));
  assert.equal(h.calls.find((call) => call.method === 'turn/start')?.params.threadId, 'native-thread');
  h.finish(); await next;
});

test('Stop during model resolution prevents a pending send after an existing turn', async () => {
  const h = harness(); const first = h.run();
  await eventually(() => Boolean(h.runtime.getState('app-session').turnId)); h.finish(); await first;
  let resolveModel!: (model: string) => void;
  h.context.resolveResumeModel = () => new Promise((resolve) => { resolveModel = resolve; });
  const running = h.run(); await eventually(() => Boolean(resolveModel));
  assert.equal(await h.runtime.abort('app-session'), true);
  resolveModel('test-model'); await running;
  assert.equal(h.calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.equal(h.events.at(-1)?.aborted, true);
});

test('child request resolution and terminal events clear only that child’s interactions', async () => {
  const h = harness(); const running = h.run();
  await eventually(() => Boolean(h.runtime.getState('app-session').turnId));
  h.event('thread/started', { thread: { id: 'child', parentThreadId: 'native-thread' } });
  const question = (id: number, threadId: string) => h.request({ id, method: 'item/tool/requestUserInput', params: {
    threadId, turnId: 'turn-1', questions: [{ id: 'q', question: 'Choose' }],
  } });
  const parentAnswer = question(1, 'native-thread');
  const childAnswer = question(2, 'child');
  h.event('serverRequest/resolved', { threadId: 'unrelated', requestId: 2 });
  assert.equal(h.runtime.getState('app-session').questions.length, 2);
  h.event('serverRequest/resolved', { threadId: 'child', requestId: 2 });
  assert.deepEqual(await childAnswer, { answers: {} });
  assert.equal(h.runtime.getState('app-session').questions.length, 1);
  const approval = h.request({ id: 3, method: 'item/commandExecution/requestApproval', params: { threadId: 'child', turnId: 'turn-1' } });
  h.event('turn/completed', { threadId: 'child', turn: { id: 'turn-1', status: 'completed' } });
  assert.deepEqual(await approval, { decision: 'cancel' });
  assert.equal(h.runtime.permissions.listPending('app-session').length, 0);
  assert.equal(h.runtime.getState('app-session').turnId, 'turn-1');
  assert.equal(h.runtime.getState('app-session').questions.length, 1);
  assert.equal(h.events.filter((event) => event.kind === 'complete').length, 0);
  const lateQuestion = question(4, 'child');
  h.event('thread/closed', { threadId: 'child' });
  assert.deepEqual(await lateQuestion, { answers: {} });
  h.finish(); await running; await parentAnswer;
  assert.equal(h.runtime.getState('app-session').questions.length, 0);
  assert.equal(h.runtime.isBusy(), false);
});

test('a successful retry clears the prior failure before streaming the new turn', async () => {
  const h = harness(); const first = h.run();
  await eventually(() => Boolean(h.runtime.getState('app-session').turnId));
  h.event('turn/completed', { turn: { id: 'turn-1', status: 'failed', error: { message: 'Temporary failure' } } });
  await first;
  assert.equal(h.runtime.getState('app-session').error, 'Temporary failure');
  const next = h.run('retry');
  await eventually(() => h.runtime.getState('app-session').turnId === 'turn-2');
  assert.equal(h.runtime.getState('app-session').error, undefined);
  h.finish('turn-2'); await next;
  assert.equal(h.runtime.getState('app-session').error, undefined);
});

test('the Codex router holds automatic queues during turns, goal gaps and persisted pauses', async () => {
  const h = harness();
  const router = createCodexRuntimeRouter({ native: h.runtime, settings: h.settingsDb });
  assert.equal(router.isQueueBlocked!('app-session'), false);
  assert.equal(h.calls.length, 0);

  const running = h.run();
  await eventually(() => Boolean(h.runtime.getState('app-session').turnId));
  assert.equal(router.isQueueBlocked!('app-session'), true);
  h.finish();
  await running;
  assert.equal(router.isQueueBlocked!('app-session'), false);

  await h.control({ action: 'goal', operation: 'set', objective: 'continue across turns' });
  assert.equal(h.runtime.getState('app-session').turnId, null);
  assert.equal(router.isQueueBlocked!('app-session'), true);
  await h.control({ action: 'goal', operation: 'pause' });
  assert.equal(h.runtime.getState('app-session').phase, 'idle');
  assert.equal(router.isQueueBlocked!('app-session'), true);
  h.settingsDb.update('app-session', { queueHeld: false });
  assert.equal(router.isQueueBlocked!('app-session'), false);
});

test('process stop interrupts a running turn, holds its queue and stays stopped during history polling', async () => {
  const h = harness();
  let confirmStop!: () => void;
  let stops = 0;
  const router = createCodexRuntimeRouter({ native: h.runtime, settings: h.settingsDb, stop: async () => {
    stops++;
    await new Promise<void>((resolve) => { confirmStop = resolve; });
    h.exit(new AppError('Codex app-server was stopped.', { code: 'CODEX_APP_SERVER_STOPPED' }));
  } });
  const control = (action: Parameters<NonNullable<typeof router.control>>[1]) => router.control!('app-session', action, h.options, h.writer, h.context);
  const running = router.run('hello', h.options, h.writer, h.context);
  await eventually(() => Boolean(h.runtime.getState('app-session').turnId));
  const stopping = control({ action: 'stop-app-server' });
  const duplicate = control({ action: 'stop-app-server' });
  await assert.rejects(router.run('racing', h.options, h.writer, h.context), { code: 'CODEX_APP_SERVER_STOPPING' });
  assert.equal(stops, 1);
  confirmStop();
  const [state] = await Promise.all([stopping, duplicate, running]);
  assert.equal(state.phase, 'idle');
  assert.equal(state.turnId, null);
  assert.equal(state.error, undefined);
  assert.equal(state.queueHeld, true);
  assert.equal(h.events.filter((event) => event.kind === 'error').length, 0);
  assert.equal(h.events.find((event) => event.kind === 'complete')?.aborted, true);
  assert.equal(router.isQueueBlocked!('app-session'), true);
  const calls = h.calls.length;
  await control({ action: 'goal', operation: 'get' });
  assert.equal(h.calls.length, calls);

  const next = router.run('explicit continuation', h.options, h.writer, h.context);
  await eventually(() => h.runtime.getState('app-session').turnId === 'turn-2');
  assert.equal(h.calls.filter((call) => call.method === 'thread/resume').length, 1);
  h.finish('turn-2'); await next;
});

test('process stop holds idle native sessions too, preventing queued work from restarting the process', async () => {
  const h = harness();
  const running = h.run();
  await eventually(() => Boolean(h.runtime.getState('app-session').turnId));
  h.finish(); await running;
  h.exit(new AppError('Codex app-server was stopped.', { code: 'CODEX_APP_SERVER_STOPPED' }));
  assert.equal(h.settings().queueHeld, true);
  assert.equal(h.runtime.getState('app-session').phase, 'idle');
  assert.equal(h.runtime.getState('app-session').error, undefined);
});

test('process stop blocks other native queues through SIGTERM timeout without blocking SDK or other providers', async () => {
  const h = harness();
  h.settingsDb.update('other-codex', { queueHeld: false });
  h.settingsDb.update('sdk-session', { runtime: 'sdk' });
  let rejectStop!: (error: Error) => void;
  let signalPending = false;
  const router = createCodexRuntimeRouter({ native: h.runtime, settings: h.settingsDb,
    isCodexSession: (id) => id !== 'claude-session', isStopping: () => signalPending,
    stop: () => {
      assert.equal(h.settingsDb.get('other-codex').queueHeld, true, 'hold every native queue before signaling');
      signalPending = true;
      return new Promise<void>((_resolve, reject) => { rejectStop = reject; });
    },
  });
  const stopping = assert.rejects(router.control!('app-session', { action: 'stop-app-server' }, h.options, h.writer, h.context), /not exited/);
  assert.equal(router.isQueueBlocked!('other-codex'), true);
  assert.equal(router.isQueueBlocked!('sdk-session'), false);
  assert.equal(router.isQueueBlocked!('claude-session'), false);
  // Even an explicit queue resume cannot dispatch into a process still stopping.
  h.settingsDb.update('other-codex', { queueHeld: false });
  assert.equal(router.isQueueBlocked!('other-codex'), true);
  rejectStop(new Error('Codex has not exited'));
  await stopping;
  assert.equal(router.isQueueBlocked!('other-codex'), true);
  await assert.rejects(router.run('queued', { ...h.options, sessionId: 'other-codex' }, h.writer, h.context), { code: 'CODEX_APP_SERVER_STOPPING' });
  signalPending = false;
  assert.equal(router.isQueueBlocked!('other-codex'), false);
  assert.equal(router.isQueueBlocked!('app-session'), true);
  assert.equal(h.calls.length, 0);
});

test('process exit finishes an abort waiting for a child turn without sending cleanup or publishing stale state', async () => {
  const h = harness(1000);
  const running = h.run();
  await eventually(() => Boolean(h.runtime.getState('app-session').turnId));
  h.event('thread/started', { thread: { id: 'child', parentThreadId: 'native-thread' } });
  h.handlers.set('thread/read', async () => ({ thread: { ephemeral: true, turns: [{ id: 'child-turn', status: 'inProgress' }] } }));
  h.handlers.set('turn/interrupt', async ({ threadId }) => {
    if (threadId === 'native-thread') h.finish('turn-1', 'interrupted');
    return {};
  });
  const aborting = h.runtime.abort('app-session');
  await eventually(() => h.calls.some(({ method, params }) => method === 'turn/interrupt' && params.threadId === 'child'));
  h.exit(new AppError('Stopped', { code: 'CODEX_APP_SERVER_STOPPED' }));
  const callsAtExit = h.calls.length;
  const eventsAtExit = h.events.length;
  await running;
  assert.equal(await Promise.race([aborting, new Promise((resolve) => setTimeout(() => resolve('timed out'), 50))]), true);
  assert.equal(h.calls.length, callsAtExit);
  assert.equal(h.events.length, eventsAtExit);
  assert.equal(h.runtime.getState('app-session').phase, 'idle');
});

test('late abort setup completion cannot mutate a replacement session after process exit', async () => {
  const h = harness();
  let resolveModel!: (model: string) => void;
  h.context.resolveResumeModel = () => new Promise((resolve) => { resolveModel = resolve; });
  const running = h.run();
  await eventually(() => Boolean(resolveModel));
  const aborting = h.runtime.abort('app-session');
  h.exit(new AppError('Stopped', { code: 'CODEX_APP_SERVER_STOPPED' }));
  assert.equal(await aborting, true);
  h.context.resolveResumeModel = async () => 'test-model';
  const next = h.run('explicit continuation');
  await eventually(() => Boolean(h.runtime.getState('app-session').turnId));
  const calls = h.calls.length;
  resolveModel('test-model');
  await running;
  assert.equal(h.calls.length, calls);
  assert.equal(h.runtime.getState('app-session').phase, 'running');
  h.finish(); await next;
});

test('process exit prevents a pending resume lookup from reopening the native process', async () => {
  const h = harness();
  h.writer.setSessionId!('native-thread');
  let resolveModel!: (model: string) => void;
  h.context.resolveResumeModel = () => new Promise((resolve) => { resolveModel = resolve; });
  const restoring = assert.rejects(h.control({ action: 'goal', operation: 'get' }), { code: 'CODEX_APP_SERVER_SESSION_CLOSED' });
  await eventually(() => Boolean(resolveModel));
  h.exit(new AppError('Codex app-server was stopped.', { code: 'CODEX_APP_SERVER_STOPPED' }));
  resolveModel('test-model');
  await restoring;
  assert.equal(h.calls.length, 0);
  assert.equal(h.runtime.getState('app-session').phase, 'idle');
});

test('a stopped initialization cannot delete a replacement session started by a later send', async () => {
  const h = harness();
  h.writer.setSessionId!('native-thread');
  let resolveModel!: (model: string) => void;
  h.context.resolveResumeModel = () => new Promise((resolve) => { resolveModel = resolve; });
  const first = h.run('cancel this initialization');
  await eventually(() => Boolean(resolveModel));
  h.exit(new AppError('Codex app-server was stopped.', { code: 'CODEX_APP_SERVER_STOPPED' }));
  h.context.resolveResumeModel = async () => 'test-model';
  const next = h.run('explicit replacement');
  await eventually(() => Boolean(h.runtime.getState('app-session').turnId));
  resolveModel('test-model'); await first;
  assert.equal(h.runtime.getState('app-session').phase, 'running');
  assert.equal(h.events.find((event) => event.kind === 'complete')?.aborted, true);
  h.finish(); await next;
});

test('process stop cancels an unacknowledged turn without reporting it as a failed turn', async () => {
  const h = harness();
  let rejectStart!: (error: Error) => void;
  h.handlers.set('turn/start', () => new Promise((_resolve, reject) => { rejectStart = reject; }));
  const running = h.run();
  await eventually(() => Boolean(rejectStart));
  const error = new AppError('Codex app-server was stopped.', { code: 'CODEX_APP_SERVER_STOPPED' });
  h.exit(error);
  rejectStart(error);
  await running;
  assert.equal(h.events.filter((event) => event.kind === 'complete').length, 1);
  assert.equal(h.events.find((event) => event.kind === 'complete')?.aborted, true);
  assert.equal(h.events.filter((event) => event.kind === 'error').length, 0);
  assert.equal(h.runtime.getState('app-session').phase, 'idle');
});

test('stopping the process cancels a runtime handoff before it can resume a native thread', async (t) => {
  const h = harness();
  h.settingsDb.update('app-session', { runtime: 'sdk' });
  h.writer.setSessionId!('native-thread');
  let release!: () => void;
  t.mock.method(h.runtime, 'releaseSession', () => new Promise<void>((resolve) => { release = resolve; }));
  const router = createCodexRuntimeRouter({ native: h.runtime, settings: h.settingsDb, stop: async () => {} });
  const switching = assert.rejects(router.control!('app-session', { action: 'runtime', runtime: 'app-server' }, h.options, h.writer, h.context), /cancelled by stopping/);
  await eventually(() => Boolean(release));
  await router.control!('app-session', { action: 'stop-app-server' }, h.options, h.writer, h.context);
  release(); await switching;
  assert.equal(h.settings().runtime, 'sdk');
  assert.equal(h.calls.length, 0);
});

test('runtime handoff waits for thread closure, excludes racing sends and resumes after SDK use', async () => {
  const h = harness(); let sdkRuns = 0;
  const router = createCodexRuntimeRouter({ native: h.runtime, settings: h.settingsDb, sdk: { run: async () => { sdkRuns++; }, abort: () => true } });
  const control = (runtime: 'sdk' | 'app-server') => router.control!('app-session', { action: 'runtime', runtime }, h.options, h.writer, h.context);
  const run = () => router.run('hello', h.options, h.writer, h.context);
  const first = run(); await eventually(() => Boolean(h.runtime.getState('app-session').turnId)); h.finish(); await first;
  await h.control({ action: 'mode', mode: 'plan' });
  await h.control({ action: 'goal', operation: 'set', objective: 'resume after SDK' });
  await h.control({ action: 'mode', mode: 'default' });
  h.handlers.set('thread/unsubscribe', async () => ({ status: 'unsubscribed' }));
  const switching = control('sdk');
  await eventually(() => h.calls.some((call) => call.method === 'thread/unsubscribe'));
  assert.equal(h.settings().runtime, 'app-server');
  await assert.rejects(run(), /runtime change/);
  await assert.rejects(control('app-server'), /runtime change/);
  h.event('thread/closed'); await switching;
  assert.equal(h.settings().runtime, 'sdk');
  assert.equal(h.settings().queueHeld, false);
  await run(); assert.equal(sdkRuns, 1);
  h.handlers.set('thread/unsubscribe', async () => ({ status: 'notLoaded' }));
  await control('app-server');
  assert.equal(h.runtime.getState('app-session').goal?.objective, 'resume after SDK');
  assert.equal(h.events.at(-1)?.codexState.goal.status, 'paused');
  assert.equal(h.events.at(-1)?.codexState.runtime, 'app-server');
  const second = run(); await eventually(() => h.runtime.getState('app-session').turnId === 'turn-2');
  assert.equal(h.calls.filter((call) => call.method === 'thread/resume').length, 1);
  h.finish('turn-2'); await second;
});

test('an unconfirmed thread unload never commits the runtime switch', async () => {
  const h = harness(15);
  const router = createCodexRuntimeRouter({ native: h.runtime, settings: h.settingsDb });
  const running = h.run(); await eventually(() => Boolean(h.runtime.getState('app-session').turnId)); h.finish(); await running;
  h.handlers.set('thread/unsubscribe', async () => ({ status: 'unsubscribed' }));
  await assert.rejects(router.control!('app-session', { action: 'runtime', runtime: 'sdk' }, h.options, h.writer, h.context), /not confirmed/);
  assert.equal(h.settings().runtime, 'app-server');
  assert.equal(h.runtime.isBusy(), false);
  h.handlers.set('thread/unsubscribe', async () => ({ status: 'notLoaded' }));
  await router.control!('app-session', { action: 'runtime', runtime: 'sdk' }, h.options, h.writer, h.context);
  assert.equal(h.settings().runtime, 'sdk');
});
