import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Codex } from '@openai/codex-sdk';

import { CodexAppServerRuntime } from '@/modules/providers/list/codex/codex-app-server.runtime.js';
import { CodexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.transport.js';
import { createCodexRuntimeRouter } from '@/modules/providers/list/codex/codex-runtime-router.provider.js';
import type { AnyRecord, ProviderRuntimeContext, SessionRuntimeSettings } from '@/shared/index.js';

async function until(check: () => boolean, description: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

/** Uses the pinned binary, an isolated CODEX_HOME and a localhost model; no account or paid inference. */
test('pinned app-server steers, stops a real background process, forks and persists native goals', { timeout: 30_000 }, async (t) => {
  const originalGoalSetting = process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
  process.env.CLOUDCLI_CODEX_GOAL_ENABLED = 'true';
  t.after(() => {
    if (originalGoalSetting === undefined) delete process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
    else process.env.CLOUDCLI_CODEX_GOAL_ENABLED = originalGoalSetting;
  });
  const require = createRequire(import.meta.url);
  let launcher: string;
  try { launcher = require.resolve('@openai/codex/bin/codex.js'); }
  catch { t.skip('The pinned Codex package is not installed.'); return; }
  if (process.platform === 'win32') { t.skip('The POSIX process probe is covered on macOS/Linux.'); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-native-smoke-'));
  const events: AnyRecord[] = [];
  let requests = 0;
  let processId: number | null = null;
  let failModel = false;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} -e ${quote('console.log("SMOKE_PID:"+process.pid);setTimeout(()=>{},20000)')}`;
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    if (failModel) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Local smoke model finished.' } }));
      return;
    }
    requests++;
    if (requests > 1) {
      const outputs = JSON.stringify(body.input.filter((item: AnyRecord) => item.type === 'function_call_output'));
      const pid = /SMOKE_PID:(\d+)/.exec(outputs);
      if (pid) processId = Number(pid[1]);
      // The provider remains busy while the test steers and interrupts it.
      return;
    }
    const item = { id: 'fc_smoke', type: 'function_call', call_id: 'call_smoke', name: 'exec_command', arguments: JSON.stringify({ cmd: command, yield_time_ms: 1000, max_output_tokens: 100 }) };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (type: string, data: AnyRecord) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit('response.created', { response: { id: 'response-smoke' } });
    emit('response.output_item.added', { output_index: 0, item });
    emit('response.output_item.done', { output_index: 0, item });
    emit('response.completed', { response: { id: 'response-smoke', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await writeFile(path.join(root, 'config.toml'), `model="gpt-5.4"\nmodel_provider="smoke"\n[model_providers.smoke]\nname="smoke"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
  const transport = new CodexAppServerTransport({ spawn: () => spawn(process.execPath, [launcher, 'app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_HOME: root },
  }), timeoutMs: 5000 });
  let settings: SessionRuntimeSettings = { runtime: 'app-server', mode: 'default', queueHeld: false };
  const runtime = new CodexAppServerRuntime(transport, { get: () => settings, update: (_, patch) => settings = { ...settings, ...patch } }, 5000, () => {});
  let threadId: string | null = null;
  const writer = { send: (event: unknown) => events.push(event as AnyRecord), setSessionId: (id: string) => { threadId = id; }, nextTurn: () => writer };
  const context: ProviderRuntimeContext = { resolveProviderSessionId: () => threadId, resolveResumeModel: async () => 'gpt-5.4',
    normalizeMessage: () => [], getProviderModels: async () => ({ DEFAULT: 'gpt-5.4', OPTIONS: [] }), isProviderInstalled: async () => true };
  const options = { sessionId: 'app-smoke', cwd: root, permissionMode: 'bypassPermissions', clientMessageId: 'first-input' };
  try {
    const running = runtime.run('Run the fixed local test command.', options, writer, context);
    await until(() => processId !== null, 'the fixed background command');
    assert.ok(events.some((event) => event.kind === 'tool_use' && event.toolName === 'Bash' && event.toolId === 'call_smoke'));
    const turnId = runtime.getState('app-smoke').turnId!;
    await runtime.control('app-smoke', { action: 'steer', expectedTurnId: turnId, requestId: 'smoke-steer', content: 'Stop after this check.', attachments: [] }, options, writer, context);
    assert.ok(events.some((event) => event.role === 'user' && event.id === 'smoke-steer'));
    assert.equal(await runtime.abort('app-smoke'), true);
    await running;
    assert.equal(runtime.getState('app-smoke').phase, 'idle');
    assert.ok(events.some((event) => event.kind === 'complete' && event.aborted));
    await until(() => { try { process.kill(processId!, 0); return false; } catch { return true; } }, 'native background terminal cleanup');
    const snapshot = await transport.request('thread/read', { threadId, includeTurns: true });
    assert.equal(snapshot.thread.cliVersion, '0.156.1');
    assert.equal(runtime.getState('app-smoke').diagnostics?.cliVersion, '0.156.1');
    assert.equal(snapshot.thread.turns.at(-1)?.status, 'interrupted');
    const fork = await transport.request('thread/fork', { threadId, cwd: root });
    assert.notEqual(fork.thread.id, threadId); await stat(fork.thread.path);
    const modes = await transport.request('collaborationMode/list', {});
    assert.ok(JSON.stringify(modes).includes('plan'));
    await runtime.control('app-smoke', { action: 'mode', mode: 'plan' }, options, writer, context);
    await runtime.control('app-smoke', { action: 'goal', operation: 'set', objective: 'Local smoke goal', tokenBudget: 1000 }, options, writer, context);
    assert.equal(runtime.getState('app-smoke').goal?.status, 'paused');
    failModel = true;
    await runtime.control('app-smoke', { action: 'mode', mode: 'default' }, options, writer, context);
    await runtime.control('app-smoke', { action: 'goal', operation: 'resume' }, options, writer, context);
    await until(() => runtime.getState('app-smoke').goal?.status === 'blocked', 'the native goal auto-turn');
    await until(() => runtime.getState('app-smoke').turnId === null, 'goal auto-turn completion');
    assert.ok(events.filter((event) => event.kind === 'complete').length >= 2);
    await runtime.control('app-smoke', { action: 'goal', operation: 'pause' }, options, writer, context);
    const persisted = await transport.request('thread/goal/get', { threadId });
    assert.equal(persisted.goal.status, 'paused');
    assert.equal(persisted.goal.objective, 'Local smoke goal');
    const rollout = await readFile(snapshot.thread.path, 'utf8');
    assert.ok(rollout.includes('first-input'));
    const input = rollout.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((row) => row.payload?.item?.client_id === 'first-input');
    assert.equal(input.payload.item.type, 'UserMessage');
  } finally {
    await runtime.abort('app-smoke');
    await transport.close(); await runtime.close();
    // Only the fixed test process is addressed if a failed assertion bypassed normal cleanup.
    if (processId) { try { process.kill(processId, 'SIGTERM'); } catch { /* already reaped */ } }
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('pinned native runtime reloads SDK additions after a confirmed runtime handoff', { timeout: 30_000 }, async (t) => {
  const require = createRequire(import.meta.url);
  let launcher: string;
  try { launcher = require.resolve('@openai/codex/bin/codex.js'); }
  catch { t.skip('The pinned Codex package is not installed.'); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-runtime-handoff-'));
  const inputs: AnyRecord[][] = [];
  const server = createServer(async (request, response) => {
    if (!request.url?.endsWith('/responses')) { response.writeHead(404); response.end(); return; }
    let text = '';
    for await (const chunk of request) text += chunk;
    inputs.push(JSON.parse(text).input);
    const reply = inputs.length === 2 ? 'SDK_ONLY_CONTEXT' : `NATIVE_REPLY_${inputs.length}`;
    const item = { id: `message-${inputs.length}`, type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: reply, annotations: [] }] };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (type: string, data: AnyRecord) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit('response.created', { response: { id: `response-${inputs.length}` } });
    emit('response.output_item.added', { output_index: 0, item });
    emit('response.output_item.done', { output_index: 0, item });
    emit('response.completed', { response: { id: `response-${inputs.length}`, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await writeFile(path.join(root, 'config.toml'), `model="gpt-5.4"\nmodel_provider="smoke"\n[model_providers.smoke]\nname="smoke"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), CODEX_HOME: root };
  const transport = new CodexAppServerTransport({ spawn: () => spawn(process.execPath, [launcher, 'app-server', '-c', 'thread_unload_delay_secs=0'], {
    stdio: ['pipe', 'pipe', 'pipe'], env,
  }), timeoutMs: 5000 });
  let settings: SessionRuntimeSettings = { runtime: 'app-server', mode: 'default', queueHeld: false };
  const settingsDb = { get: () => settings, update: (_: string, patch: Partial<SessionRuntimeSettings>) => settings = { ...settings, ...patch } };
  const runtime = new CodexAppServerRuntime(transport, settingsDb, 5000, () => {});
  let threadId: string | null = null;
  const writer = { send: () => {}, setSessionId: (id: string) => { threadId = id; } };
  const context: ProviderRuntimeContext = { resolveProviderSessionId: () => threadId, resolveResumeModel: async () => 'gpt-5.4',
    normalizeMessage: () => [], getProviderModels: async () => ({ DEFAULT: 'gpt-5.4', OPTIONS: [] }), isProviderInstalled: async () => true };
  const sdk = new Codex({ env });
  const router = createCodexRuntimeRouter({ native: runtime, settings: settingsDb, sdk: {
    async run(command) {
      return sdk.resumeThread(threadId!, { workingDirectory: root, skipGitRepoCheck: true, model: 'gpt-5.4' })
        .run(command, { signal: AbortSignal.timeout(10_000) });
    },
    abort: () => false,
  } });
  const options = { sessionId: 'app-handoff', cwd: root };
  try {
    await router.run('First native message.', options, writer, context);
    const originalThreadId = threadId;
    await router.control!('app-handoff', { action: 'runtime', runtime: 'sdk' }, options, writer, context);
    const loaded = await transport.request('thread/loaded/list', {});
    assert.ok(!loaded.data.includes(originalThreadId), 'switch must wait until the native thread is actually unloaded');
    await router.run('Reply through SDK compatibility.', options, writer, context);
    await router.control!('app-handoff', { action: 'runtime', runtime: 'app-server' }, options, writer, context);
    await router.run('Continue with the latest context.', options, writer, context);
    assert.equal(threadId, originalThreadId);
    assert.equal(inputs.length, 3);
    assert.match(JSON.stringify(inputs[1]), /NATIVE_REPLY_1/);
    assert.match(JSON.stringify(inputs[2]), /SDK_ONLY_CONTEXT/);
  } finally {
    await runtime.abort('app-handoff');
    await transport.close(); await runtime.close();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
