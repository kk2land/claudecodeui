import assert from 'node:assert/strict';
import test from 'node:test';

import { createCodexAppServerClient } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { codexAppServerRuntime } from '@/modules/providers/list/codex/codex-app-server-runtime.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import type { AnyRecord, CodexAppServerClientOptions, ProviderRuntimeContext } from '@/shared/types.js';

function harness(resume = false) {
  let callbacks: CodexAppServerClientOptions;
  let closed = false;
  const calls: Array<{ method: string; params: AnyRecord }> = [];
  const replies: Array<{ id: string | number; result: AnyRecord }> = [];
  const messages: AnyRecord[] = [];
  const normalizer = new CodexSessionsProvider();
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => resume ? 'thread-native' : null,
    resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ DEFAULT: 'test-model', OPTIONS: [] }),
    normalizeMessage: (raw, sessionId) => normalizer.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createCodexAppServer(options) {
      callbacks = options;
      return {
        async initialize(experimental) { assert.equal(experimental, true); },
        async call(method, params) {
          calls.push({ method, params: params as AnyRecord });
          if (method.startsWith('thread/')) return { thread: { id: 'thread-native' }, model: 'test-model' };
          if (method === 'turn/start') return { turn: { id: 'turn-active', status: 'inProgress' } };
          if (method === 'turn/steer') return { turnId: 'turn-active' };
          return {};
        },
        respond(id, result) { replies.push({ id, result: result as AnyRecord }); },
        respondError(id, message) { replies.push({ id, result: { error: message } }); },
        close() { closed = true; },
      };
    },
  };
  return {
    context, calls, replies, messages,
    writer: { isWebSocketWriter: true, send(message: unknown) { messages.push(message as AnyRecord); } },
    event(method: string, params: AnyRecord, id?: string | number) { callbacks.onMessage?.({ method, params: { threadId: 'thread-native', ...params }, ...(id === undefined ? {} : { id }) }); },
    crash() { callbacks.onExit?.(new Error('process crashed')); },
    get closed() { return closed; },
  };
}

const waitForTurn = async (script: ReturnType<typeof harness>) => {
  for (let i = 0; i < 100 && !script.calls.some((entry) => entry.method === 'turn/start'); i++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(script.calls.some((entry) => entry.method === 'turn/start'));
};

for (const resume of [false, true]) {
  test(`app-server ${resume ? 'resumes' : 'starts'} native thread and selects real Plan mode`, async () => {
    const script = harness(resume);
    const running = codexAppServerRuntime.run('/plan investigate failures', { sessionId: 'app-session', cwd: '/tmp/project', permissionMode: 'plan' }, script.writer, script.context);
    await waitForTurn(script);
    assert.equal(script.calls[0].method, resume ? 'thread/resume' : 'thread/start');
    assert.equal(script.calls[0].params.threadId, resume ? 'thread-native' : undefined);
    assert.equal(script.calls[0].params.cwd, '/tmp/project');
    assert.equal(script.calls[0].params.approvalPolicy, 'on-request');
    assert.deepEqual(script.calls[1].params.collaborationMode, { mode: 'plan', settings: { model: 'test-model', reasoning_effort: null, developer_instructions: null } });
    assert.deepEqual(script.calls[1].params.input, [{ type: 'text', text: 'investigate failures' }]);
    script.event('turn/completed', { turn: { id: 'turn-active', status: 'completed' } });
    await running;
    assert.equal(script.messages.filter((message) => message.kind === 'complete').length, 1);
    assert.equal(script.closed, true);
  });
}

test('steer stays on the active turn, preserves mode and echoes only accepted input', async () => {
  const script = harness(true);
  const running = codexAppServerRuntime.run('start', { sessionId: 'app-steer', permissionMode: 'default' }, script.writer, script.context);
  await waitForTurn(script);
  assert.equal(script.calls[1].params.collaborationMode.mode, 'default');
  assert.equal(await codexAppServerRuntime.steer('app-steer', 'focus on tests', {}), true);
  assert.deepEqual(script.calls.at(-1), { method: 'turn/steer', params: { threadId: 'thread-native', expectedTurnId: 'turn-active', input: [{ type: 'text', text: 'focus on tests' }] } });
  assert.equal(script.calls.filter((entry) => entry.method === 'turn/start').length, 1);
  assert.equal(script.messages.filter((message) => message.role === 'user').length, 1);
  script.event('turn/completed', { turn: { id: 'turn-active', status: 'completed' } });
  assert.equal(await codexAppServerRuntime.steer('app-steer', 'late input', {}), false);
  await running;
});

test('app-server maps text, command progress, proposed plans and token usage without premature completion', async () => {
  const script = harness();
  const running = codexAppServerRuntime.run('start', { sessionId: 'app-events' }, script.writer, script.context);
  await waitForTurn(script);
  script.event('item/started', { item: { id: 'cmd', type: 'commandExecution', command: 'npm test', status: 'inProgress' } });
  script.event('item/commandExecution/outputDelta', { itemId: 'cmd', delta: 'passed' });
  script.event('item/agentMessage/delta', { itemId: 'text', delta: 'hello' });
  script.event('item/agentMessage/delta', { itemId: 'text', delta: ' world' });
  script.event('item/completed', { item: { id: 'text', type: 'agentMessage', text: 'final answer' } });
  script.event('item/plan/delta', { itemId: 'plan', delta: 'draft' });
  script.event('item/completed', { item: { id: 'plan', type: 'plan', text: 'authoritative plan' } });
  script.event('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 42, inputTokens: 40, outputTokens: 2 }, modelContextWindow: 1000 } });
  assert.equal([...script.messages].reverse().find((message) => message.id === 'text')?.content, 'final answer');
  assert.equal([...script.messages].reverse().find((message) => message.id === 'plan')?.toolInput.plan, 'authoritative plan');
  assert.ok(script.messages.some((message) => message.kind === 'tool_result' && message.content === 'passed'));
  assert.equal(script.messages.at(-1)?.tokenBudget.used, 42);
  assert.equal(script.messages.filter((message) => message.kind === 'complete').length, 0);
  script.event('turn/completed', { turn: { id: 'turn-active', status: 'failed', error: { message: 'model failed' } } });
  await running;
  assert.equal(script.messages.at(-1)?.exitCode, 1);
});

test('Plan questions and approvals can be replayed, answered, or retracted by the server', async () => {
  const script = harness();
  const running = codexAppServerRuntime.run('plan', { sessionId: 'app-permissions' }, script.writer, script.context);
  await waitForTurn(script);
  script.event('item/tool/requestUserInput', { questions: [{ id: 'target', question: 'Which target?', header: 'Target', options: null }] }, 7);
  let pending = codexAppServerRuntime.permissions.listPending('app-permissions');
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].input.questions[0].options, []);
  codexAppServerRuntime.permissions.resolve(pending[0].requestId, { allow: true, updatedInput: { answers: { target: 'backend' } } });
  assert.deepEqual(script.replies[0], { id: 7, result: { answers: { target: { answers: ['backend'] } } } });
  script.event('item/commandExecution/requestApproval', { itemId: 'cmd', command: 'npm test' }, 8);
  pending = codexAppServerRuntime.permissions.listPending('app-permissions');
  codexAppServerRuntime.permissions.resolve(pending[0].requestId, { allow: false });
  assert.deepEqual(script.replies[1], { id: 8, result: { decision: 'decline' } });
  script.event('item/fileChange/requestApproval', { itemId: 'edit' }, 9);
  script.event('serverRequest/resolved', { requestId: 9 });
  assert.equal(codexAppServerRuntime.permissions.listPending('app-permissions').length, 0);
  script.event('turn/completed', { turn: { id: 'turn-active', status: 'completed' } });
  await running;
});

test('abort and unexpected process exit release runs and pending requests', async () => {
  for (const crash of [false, true]) {
    const script = harness();
    const running = codexAppServerRuntime.run('start', { sessionId: 'app-stop' }, script.writer, script.context);
    await waitForTurn(script);
    script.event('item/tool/requestUserInput', { questions: [] }, 4);
    if (crash) script.crash();
    else assert.equal(await codexAppServerRuntime.abort('app-stop'), true);
    await running;
    assert.equal(codexAppServerRuntime.permissions.listPending('app-stop').length, 0);
    assert.equal(await codexAppServerRuntime.steer('app-stop', 'late', {}), false);
    assert.equal(script.closed, true);
    assert.equal(script.messages.filter((message) => message.kind === 'complete').length, crash ? 1 : 0);
  }
});

test('capabilities opt into Plan and steer only with CODEX_RUNTIME=app-server', () => {
  const previous = process.env.CODEX_RUNTIME;
  try {
    for (const value of ['exec', 'app-server']) {
      process.env.CODEX_RUNTIME = value;
      const capabilities = providerCapabilitiesService.listAllProviderCapabilities().find((entry) => entry.provider === 'codex')!;
      assert.equal(capabilities.supportsSteer, value === 'app-server');
      assert.equal(capabilities.permissionModes.includes('plan'), value === 'app-server');
      assert.equal(capabilities.supportsPermissionRequests, value === 'app-server');
    }
  } finally {
    if (previous === undefined) delete process.env.CODEX_RUNTIME; else process.env.CODEX_RUNTIME = previous;
  }
});

test('bundled CLI accepts experimental stdio handshake without invoking a model', async () => {
  const client = createCodexAppServerClient();
  try {
    await client.initialize(true);
    const result = await client.call('collaborationMode/list', {});
    assert.ok(result.data.some((mode: AnyRecord) => mode.mode === 'plan'));
  } finally { client.close(); }
});

test('steer arriving during initialization waits for the correct active turn', async () => {
  const script = harness();
  let resolveModel!: (model: string) => void;
  script.context.resolveResumeModel = () => new Promise((resolve) => { resolveModel = resolve; });
  const running = codexAppServerRuntime.run('start', { sessionId: 'app-early' }, script.writer, script.context);
  const steering = codexAppServerRuntime.steer('app-early', 'more context', {});
  assert.equal(script.calls.length, 0);
  resolveModel('test-model');
  assert.equal(await steering, true);
  assert.equal(script.calls.at(-1)?.params.expectedTurnId, 'turn-active');
  script.event('turn/completed', { turn: { id: 'turn-active', status: 'completed' } });
  await running;
});

test('turn completion waits for an outstanding steer acknowledgment before closing its process', async () => {
  const script = harness();
  const create = script.context.createCodexAppServer!;
  let acknowledge!: (value: AnyRecord) => void;
  script.context.createCodexAppServer = (options) => {
    const client = create(options);
    const call = client.call;
    client.call = async (method, params) => {
      if (method === 'turn/steer') return new Promise((resolve) => { acknowledge = resolve; });
      return call(method, params);
    };
    return client;
  };
  const running = codexAppServerRuntime.run('start', { sessionId: 'app-ack' }, script.writer, script.context);
  await waitForTurn(script);
  const steering = codexAppServerRuntime.steer('app-ack', 'accepted input', {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  script.event('turn/completed', { turn: { id: 'turn-active', status: 'completed' } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(script.closed, false);
  acknowledge({ turnId: 'turn-active' });
  assert.equal(await steering, true);
  await running;
  assert.equal(script.messages.at(-1)?.kind, 'complete');
  assert.ok(script.messages.some((message) => message.role === 'user' && message.id.startsWith('local_')));
  assert.equal(script.closed, true);
});

test('app-server sends images using native localImage inputs and preserves bypass permissions', async () => {
  const script = harness();
  const running = codexAppServerRuntime.run('', { sessionId: 'app-images', cwd: process.cwd(), permissionMode: 'bypassPermissions', images: [{ path: `${process.cwd()}/public/favicon.png`, mimeType: 'image/png' }] }, script.writer, script.context);
  await waitForTurn(script);
  assert.equal(script.calls[0].params.sandbox, 'danger-full-access');
  assert.equal(script.calls[0].params.approvalPolicy, 'never');
  assert.equal(script.calls[1].params.input[1].type, 'localImage');
  assert.equal(script.calls[1].params.input[0].text, 'Please analyze the attached image(s).');
  script.event('turn/completed', { turn: { id: 'turn-active', status: 'completed' } });
  await running;
});
