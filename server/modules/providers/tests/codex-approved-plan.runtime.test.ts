import assert from 'node:assert/strict';
import test from 'node:test';

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

const MARKDOWN = [
  '# Approved plan',
  '',
  'First paragraph explains the change.',
  '',
  '- step one with `inline code`',
  '- step two with unicode: 中文',
  '',
  '```ts',
  'console.log("second paragraph stays intact");',
  '```',
].join('\n');
const PREPARED_PROMPT = 'Run the approved plan.\n\n1. Edit src/a.ts\n2. Run the tests';

type PrepareBehavior = 'resolve' | 'reject' | 'unknown' | 'timeout' | 'pending';

function harness(behavior: PrepareBehavior = 'resolve', cliVersion: () => string | null = () => '0.169.1') {
  const calls: Array<{ method: string; params: AnyRecord }> = [];
  let notify: (frame: CodexRpcFrame) => void = () => {};
  let nativeId: string | null = null;
  let releasePrepare: ((value: AnyRecord) => void) | null = null;
  let nextTurnId = 1;

  const rpc: CodexRpcClient = {
    async request<T>(method: string, params: AnyRecord = {}) {
      calls.push({ method, params });
      switch (method) {
        case 'thread/start':
        case 'thread/resume':
          return { thread: { id: 'native-thread' } } as T;
        case 'thread/prepareApprovedPlan':
          if (behavior === 'resolve') return { prompt: PREPARED_PROMPT } as T;
          if (behavior === 'reject') {
            throw new AppError('plan is too long', {
              code: 'CODEX_APP_SERVER_REJECTED', statusCode: 502, details: { rpcCode: -32602 },
            });
          }
          if (behavior === 'unknown') {
            throw new AppError('unknown method: thread/prepareApprovedPlan', {
              code: 'CODEX_APP_SERVER_REJECTED', statusCode: 502, details: { rpcCode: -32601 },
            });
          }
          if (behavior === 'timeout') {
            throw new AppError('Codex app-server did not confirm thread/prepareApprovedPlan.', {
              code: 'CODEX_APP_SERVER_TIMEOUT', statusCode: 504,
              details: { method: 'thread/prepareApprovedPlan', resultUnknown: true },
            });
          }
          return await new Promise<AnyRecord>((resolve) => { releasePrepare = resolve; }) as T;
        case 'turn/start':
          return { turn: { id: `turn-${nextTurnId++}` } } as T;
        case 'thread/read':
          return { thread: { turns: [] } } as T;
        case 'thread/unsubscribe':
          return { status: 'notLoaded' } as T;
        default:
          return {} as T;
      }
    },
    onNotification(fn) { notify = fn; return () => {}; },
    onRequest() { return () => {}; },
    onExit() { return () => {}; },
  } as CodexRpcClient;

  const settings = new Map<string, SessionRuntimeSettings>();
  const settingsDb = {
    get: (id: string): SessionRuntimeSettings => settings.get(id) ?? { runtime: 'app-server', mode: 'default', queueHeld: false },
    update(id: string, patch: Partial<SessionRuntimeSettings>) {
      const value = { ...this.get(id), ...patch };
      settings.set(id, value);
      return value;
    },
  };
  const runtime = new CodexAppServerRuntime(rpc, settingsDb, 200, () => {}, async () => [], 1_000, {
    cliVersion,
    modelProviders: {
      list: async () => ({
        defaultProvider: 'openai', hasCustomProviders: false, canChangeDefault: true,
        providers: [{ id: 'openai', name: 'OpenAI', baseUrl: null, canEdit: true, settings: { type: 'openai' as const } }],
      }),
      models: async (modelProvider: string) => ({ modelProvider, models: ['test-model'], items: [] }),
    },
  });

  const events: AnyRecord[] = [];
  const writer: ProviderRuntimeWriter = {
    send: (data) => events.push(data as AnyRecord),
    setSessionId: (id) => { nativeId = id; },
  };
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => nativeId,
    resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ DEFAULT: 'test-model', OPTIONS: [] }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  };
  const options = {
    sessionId: 'app-session', cwd: '/tmp', model: 'test-model', effort: 'high', clientMessageId: 'client-plan-1',
  };
  const event = (method: string, params: AnyRecord = {}) => notify({ method, params: { threadId: 'native-thread', ...params } });
  return {
    runtime, calls, events, context, options,
    event,
    run: (extra: AnyRecord = {}) => runtime.run('composer text that must not be sent', { ...options, ...extra }, writer, context),
    finish: (id = `turn-${nextTurnId - 1}`) => event('turn/completed', { turn: { id, status: 'completed' } }),
    halt: () => runtime.abort('app-session'),
    releasePrepare: (value: AnyRecord) => releasePrepare?.(value),
    prepared: () => releasePrepare !== null,
    methods: () => calls.map((call) => call.method),
    call: (method: string) => calls.find((call) => call.method === method),
  };
}

async function eventually(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(predicate(), 'expected state was never reached');
}

test('an approved plan is prepared between thread/start and turn/start and runs verbatim', async (t) => {
  const h = harness();
  t.after(() => h.runtime.close());
  const running = h.run({ approvedPlan: { markdown: MARKDOWN } });
  await eventually(() => h.methods().includes('turn/start'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(h.methods().slice(0, 3), ['thread/start', 'thread/prepareApprovedPlan', 'turn/start']);
  assert.equal(h.call('thread/prepareApprovedPlan')!.params.threadId, 'native-thread');
  assert.equal(h.call('thread/prepareApprovedPlan')!.params.markdown, MARKDOWN);
  assert.equal(h.call('thread/prepareApprovedPlan')!.params.attachmentPath, undefined);
  const start = h.call('turn/start')!.params;
  assert.deepEqual(start.input, [{ type: 'text', text: PREPARED_PROMPT, text_elements: [] }]);
  assert.equal(start.clientUserMessageId, 'client-plan-1');
  assert.notEqual(start.input[0].text, MARKDOWN);

  h.finish();
  await running;

  // The plan belongs to its own turn only: the next turn prepares nothing.
  const next = h.run();
  await eventually(() => h.calls.filter((call) => call.method === 'turn/start').length === 2);
  assert.equal(h.calls.filter((call) => call.method === 'thread/prepareApprovedPlan').length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  h.finish();
  await next;
});

test('a native user echo without a client id is correlated to the submitted plan turn', async (t) => {
  const h = harness();
  t.after(() => h.runtime.close());
  const running = h.run({ approvedPlan: { markdown: MARKDOWN } });
  await eventually(() => h.methods().includes('turn/start'));
  await new Promise((resolve) => setImmediate(resolve));

  h.event('item/started', {
    turnId: 'turn-1',
    item: { id: 'native-user-echo', type: 'userMessage', content: [{ type: 'text', text: PREPARED_PROMPT }] },
  });
  const echo = h.events.find((event) => event.kind === 'text' && event.role === 'user');
  assert.ok(echo, 'the native user echo is forwarded');
  assert.equal(echo.clientMessageId, 'client-plan-1');
  assert.equal(echo.content, PREPARED_PROMPT);

  h.finish();
  await running;
});

for (const [label, behavior, expected] of [
  ['a provider refusal', 'reject', /plan is too long/],
  ['an unknown method', 'unknown', /does not support native plan handoff/],
  ['a prepare timeout', 'timeout', /did not confirm thread\/prepareApprovedPlan/],
] as const) {
  test(`${label} reports an error, starts no turn and releases the run`, async (t) => {
    const h = harness(behavior);
    t.after(() => h.runtime.close());
    const running = h.run({ approvedPlan: { markdown: MARKDOWN } });
    await Promise.race([
      running,
      new Promise((_, reject) => setTimeout(() => reject(new Error('the run never settled')), 1_000)),
    ]);

    assert.ok(h.methods().includes('thread/start'));
    assert.ok(!h.methods().includes('turn/start'), 'no native turn is started');
    const error = h.events.find((event) => event.kind === 'error');
    assert.ok(error, 'an error message is shown');
    assert.match(String(error.content), expected);
    const complete = h.events.find((event) => event.kind === 'complete');
    assert.equal(complete?.exitCode, 1);
    assert.equal(h.runtime.getState('app-session').phase, 'failed');
  });
}

test('a Stop during prepare ends the run without starting a turn', async (t) => {
  const h = harness('pending');
  t.after(() => h.runtime.close());
  const running = h.run({ approvedPlan: { markdown: MARKDOWN } });
  await eventually(() => h.prepared());

  await h.halt();
  h.releasePrepare({ prompt: 'late prompt' });
  await running;

  assert.ok(!h.methods().includes('turn/start'), 'Stop wins over the pending handoff');
  const complete = h.events.find((event) => event.kind === 'complete');
  assert.equal(complete?.aborted, true);
});

for (const [label, version, expected] of [
  ['0.169.0', '0.169.0', false],
  ['0.169.1', '0.169.1', true],
  ['an unknown build', null, false],
  ['a pre-release build', '0.170.0-alpha.1', false],
] as const) {
  test(`an unloaded snapshot reports plan handoff ${expected} for ${label}`, (t) => {
    const h = harness('resolve', () => version);
    t.after(() => h.runtime.close());
    // Reading the snapshot never starts the app-server: the flag comes from the
    // identity already injected for `initialize`.
    assert.equal(h.runtime.getState('app-session').planHandoffSupported, expected);
    assert.equal(h.calls.length, 0);
  });
}
