import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionRuntimeDb, sessionsDb } from '@/modules/database/index.js';
import { CodexAppServerRuntime } from '@/modules/providers/list/codex/codex-app-server.runtime.js';
import { codexAppServerTransport, CodexAppServerConnections, CodexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.transport.js';
import { CodexModelProviderService } from '@/modules/providers/list/codex/codex-model-provider.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import type { AnyRecord, ProviderRuntimeContext, SessionRuntimeSettings } from '@/shared/index.js';

// The native app-server runs the pinned compatible CLI (`@openai/codex-app-server-compat`),
// not the root package whose model catalog and SDK runs stay on the main-branch release.
const compatTransportIdentity = new CodexAppServerTransport().status;
const APP_SERVER_COMPAT_CLI_VERSION = compatTransportIdentity.cliVersion ?? '';
const APP_SERVER_COMPAT_LAUNCHER = compatTransportIdentity.launcherPath ?? '';

/** Reproduces first-send admission using the installed CLI and isolated local endpoints. */
test('a new magpie conversation sends and resumes independently of the OpenAI default', { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-magpie-session-'));
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.url?.endsWith('/models')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'gpt-5.4' }] }));
      return;
    }
    // A default OpenAI thread may warm up a WebSocket on creation. No OpenAI
    // turn is submitted here; only custom-provider inference is served locally.
    if (request.method !== 'POST') {
      response.writeHead(404, { 'Content-Length': '0' });
      response.end();
      return;
    }
    for await (const _chunk of request) { /* Drain the request before responding. */ }
    requests.push(request.url!);
    const id = `response-${requests.length}`;
    const item = { id: `message-${requests.length}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (type: string, data: AnyRecord) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit('response.created', { response: { id } });
    emit('response.output_item.added', { output_index: 0, item });
    emit('response.output_item.done', { output_index: 0, item });
    emit('response.completed', { response: { id, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const config = `model="gpt-5.4"\nweb_search="disabled"\nopenai_base_url="http://127.0.0.1:${address.port}/openai"\n`
    + `[model_providers.magpie]\nname="Magpie"\nbase_url="http://127.0.0.1:${address.port}/magpie"\nwire_api="responses"\nrequires_openai_auth=false\n`;
  await writeFile(path.join(root, 'config.toml'), config);
  const transports: CodexAppServerConnections[] = [];
  // CI normally uses the package-pinned compat CLI. An explicit test-only binary
  // lets a developer validate that same release without replacing the local
  // launcher a proxy deployment owns.
  const binary = process.env.CLOUDCLI_CODEX_TEST_BINARY;
  const createTransport = () => {
    const transport = new CodexAppServerConnections((modelProvider) => new CodexAppServerTransport({
      spawn: () => spawn(binary || process.execPath, [...(binary ? [] : [APP_SERVER_COMPAT_LAUNCHER]), 'app-server',
        '-c', 'thread_unload_delay_secs=0', '-c', 'features.goals=false',
        ...(modelProvider ? ['-c', `model_provider=${JSON.stringify(modelProvider)}`] : [])], {
        cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_HOME: root, OPENAI_API_KEY: 'local-test-only' },
      }), timeoutMs: 10_000,
    }));
    transports.push(transport);
    return transport;
  };
  const saved = new Map<string, SessionRuntimeSettings>();
  const settings = {
    get: (id: string): SessionRuntimeSettings => saved.get(id) ?? { runtime: 'app-server', mode: 'default', queueHeld: false },
    update: (id: string, patch: Partial<SessionRuntimeSettings>) => { saved.set(id, { ...settings.get(id), ...patch }); return settings.get(id); },
  };
  const modelProviders = new CodexModelProviderService({ home: root, environment: {} });
  const createRuntime = (transport: CodexAppServerConnections) => new CodexAppServerRuntime(transport, settings, 10_000,
    () => {}, async () => [], 30_000, { modelProviders });
  const bindings = new Map<string, string>();
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: (id) => bindings.get(id ?? '') ?? null,
    resolveResumeModel: async () => 'gpt-5.4', getProviderModels: async () => ({ DEFAULT: 'gpt-5.4', OPTIONS: [] }),
    normalizeMessage: () => [], isProviderInstalled: async () => true,
  };
  const failures: AnyRecord[] = [];
  const writer = (id: string) => ({ send: (message: unknown) => {
    const event = message as AnyRecord;
    if (event.kind === 'error' || event.kind === 'complete' && event.exitCode !== 0) failures.push(event);
  }, setSessionId: (threadId: string) => { bindings.set(id, threadId); } });
  const options = (id: string) => ({ sessionId: id, cwd: root, model: 'gpt-5.4', permissionMode: 'default' });
  const originalGoals = process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
  process.env.CLOUDCLI_CODEX_GOAL_ENABLED = 'false';
  let runtime = createRuntime(createTransport());
  t.after(async () => {
    await Promise.all(transports.map((transport) => transport.close()));
    await runtime.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalGoals === undefined) delete process.env.CLOUDCLI_CODEX_GOAL_ENABLED; else process.env.CLOUDCLI_CODEX_GOAL_ENABLED = originalGoals;
    await rm(root, { recursive: true, force: true });
  });

  await runtime.control('magpie', { action: 'model-provider', modelProvider: 'magpie', model: 'gpt-5.4' }, options('magpie'), writer('magpie'), context);
  await runtime.run('first-magpie-message', options('magpie'), writer('magpie'), context);
  const magpieThread = bindings.get('magpie');
  // Load a native default-provider conversation without using paid inference.
  const defaultThread = await transports[0].request('thread/start', { modelProvider: (await modelProviders.list()).defaultProvider,
    model: 'gpt-5.4', cwd: root, historyMode: 'legacy' });
  await runtime.run('second-magpie-message', options('magpie'), writer('magpie'), context);
  assert.deepEqual(failures, [], 'magpie turns must succeed while the default service remains loaded');
  assert.deepEqual(requests, ['/magpie/responses', '/magpie/responses']);
  assert.equal(runtime.getState('magpie').activeModelSelection?.modelProvider, 'magpie');
  assert.equal(defaultThread.modelProvider, 'openai');
  assert.notEqual(runtime.getState('magpie').diagnostics?.pid, transports[0].statusForThread(defaultThread.thread.id).pid);

  // Discard both process and routing state; persisted conversation settings and
  // native history must still select their services after a backend restart.
  await transports[0].close();
  await runtime.close();
  runtime = createRuntime(createTransport());
  await runtime.run('magpie-after-restart', options('magpie'), writer('magpie'), context);
  assert.equal(bindings.get('magpie'), magpieThread);
  assert.deepEqual(failures, []);
  assert.deepEqual(requests.slice(2), ['/magpie/responses']);
  assert.equal(await readFile(path.join(root, 'config.toml'), 'utf8'), config);
  assert.equal((await modelProviders.list()).defaultProvider, 'openai');
});


/** Uses an isolated Codex home and two local Responses endpoints; no credentials or paid inference. */
test('pinned Codex preserves model services across switching, forking, and independent session resumes', { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-model-provider-smoke-'));
  const requests: Array<{ url: string; body: AnyRecord }> = [];
  let finishFirst: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    if (request.url?.endsWith('/models')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'gpt-5.4' }] }));
      return;
    }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ url: request.url!, body });
    const number = requests.length;
    const finish = () => {
      const id = `response-${number}`;
      const item = { id: `message-${number}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `answer-${number}` }] };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (type: string, data: AnyRecord) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      emit('response.created', { response: { id } });
      emit('response.output_item.added', { output_index: 0, item });
      emit('response.output_item.done', { output_index: 0, item });
      emit('response.completed', { response: { id, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
      response.end();
    };
    if (number === 1) finishFirst = finish; else finish();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await writeFile(path.join(root, 'config.toml'), `model="gpt-5.4"\nmodel_provider="alpha"\nweb_search="disabled"\n`
    + ['alpha', 'beta'].map((id) => `[model_providers.${id}]\nname="${id}"\nbase_url="http://127.0.0.1:${address.port}/${id}"\nwire_api="responses"\nrequires_openai_auth=false\n`).join(''));
  // CI normally uses the package-pinned CLI. An explicit test-only binary lets
  // a developer validate that same release without replacing a local launcher.
  const binary = process.env.CLOUDCLI_CODEX_TEST_BINARY;
  const transport = new CodexAppServerConnections((modelProvider) => new CodexAppServerTransport({ spawn: () => spawn(binary || process.execPath,
    [...(binary ? [] : [APP_SERVER_COMPAT_LAUNCHER]), 'app-server', '-c', 'thread_unload_delay_secs=0', '-c', 'features.goals=false',
      ...(modelProvider ? ['-c', `model_provider=${JSON.stringify(modelProvider)}`] : [])],
    { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_HOME: root } }), timeoutMs: 10_000 }));
  const previousDatabasePath = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'cloudcli.db');
  await initializeDatabase();
  for (const id of ['one', 'two']) {
    sessionsDb.createAppSession(id, 'codex', root);
    sessionRuntimeDb.update(id, { runtime: 'app-server' });
  }
  // The production fork client shares this same isolated native process.
  t.mock.method(codexAppServerTransport, 'request', (method: string, params: unknown) => transport.request(method, params));
  const modelProviders = new CodexModelProviderService({ home: root, environment: {} });
  const runtime = new CodexAppServerRuntime(transport, sessionRuntimeDb, 10_000, () => {}, async () => [], 30_000,
    { modelProviders });
  const bindings = new Map<string, string>();
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: (id) => bindings.get(id ?? '') ?? null,
    resolveResumeModel: async () => 'gpt-5.4', getProviderModels: async () => ({ DEFAULT: 'gpt-5.4', OPTIONS: [] }),
    normalizeMessage: () => [], isProviderInstalled: async () => true,
  };
  const writer = (id: string) => ({ send: () => {}, setSessionId: (threadId: string) => {
    bindings.set(id, threadId);
    sessionsDb.assignProviderSessionId(id, threadId);
  } });
  const options = (id: string) => ({ sessionId: id, cwd: root, model: 'gpt-5.4', effort: 'high', permissionMode: 'default' });
  const originalGoals = process.env.CLOUDCLI_CODEX_GOAL_ENABLED;
  process.env.CLOUDCLI_CODEX_GOAL_ENABLED = 'false';
  try {
    const first = runtime.run('remember-first-input', options('one'), writer('one'), context);
    const deadline = Date.now() + 10_000;
    while (!finishFirst) { assert.ok(Date.now() < deadline, 'first model request'); await new Promise((resolve) => setTimeout(resolve, 10)); }
    const originalThread = bindings.get('one');
    await assert.rejects(runtime.control('one', { action: 'model-provider', modelProvider: 'beta', model: 'gpt-5.4' }, options('one'), writer('one'), context), { code: 'CODEX_MODEL_PROVIDER_BUSY' });
    assert.equal(runtime.getState('one').activeModelSelection?.modelProvider, 'alpha');
    await runtime.run('other-session-input', options('two'), writer('two'), context);
    const completeFirst = finishFirst;
    finishFirst = undefined;
    completeFirst(); await first;
    await runtime.control('one', { action: 'model-provider', modelProvider: 'beta', model: 'gpt-5.4' }, options('one'), writer('one'), context);
    await runtime.run('next-input', { ...options('one'), model: 'stale-queued-model' }, writer('one'), context);
    assert.equal(bindings.get('one'), originalThread);
    assert.equal(runtime.getState('one').activeModelSelection?.modelProvider, 'beta');
    assert.equal(runtime.getState('one').diagnostics?.cliVersion, APP_SERVER_COMPAT_CLI_VERSION);
    assert.equal(runtime.getState('two').activeModelSelection?.modelProvider, 'alpha');
    await runtime.run('other-session-again', options('two'), writer('two'), context);
    assert.deepEqual(requests.map((request) => request.url), ['/alpha/responses', '/alpha/responses', '/beta/responses', '/alpha/responses']);
    assert.ok(JSON.stringify(requests[2].body.input).includes('remember-first-input'));
    assert.ok(JSON.stringify(requests[2].body.input).includes('next-input'));
    assert.equal(requests[2].body.model, 'gpt-5.4');
    assert.deepEqual(requests.map((request) => request.body.reasoning?.effort), ['high', 'high', 'high', 'high']);
    assert.equal(JSON.stringify(requests[2].body.input).includes('other-session-input'), false);

    const source = await transport.request<{ thread: { path: string } }>('thread/read', { threadId: originalThread });
    sessionsDb.repointSessionToProviderSession('one', { providerSessionId: originalThread!, jsonlPath: source.thread.path });
    const fork = await sessionsService.forkSessionById('one');
    const childThread = sessionsDb.getSessionById(fork.sessionId)!.provider_session_id!;
    assert.notEqual(childThread, originalThread);
    bindings.set(fork.sessionId, childThread);
    assert.deepEqual(sessionRuntimeDb.get(fork.sessionId).modelSelection, { modelProvider: 'beta', model: 'gpt-5.4' });

    await runtime.run('fork-only-input', options(fork.sessionId), writer(fork.sessionId), context);
    assert.equal(runtime.getState(fork.sessionId).activeModelSelection?.modelProvider, 'beta');
    assert.equal(requests[4].url, '/beta/responses');
    assert.equal(requests[4].body.model, 'gpt-5.4');
    for (const prompt of ['remember-first-input', 'next-input', 'fork-only-input']) {
      assert.ok(JSON.stringify(requests[4].body.input).includes(prompt));
    }
    assert.equal(JSON.stringify(requests[4].body.input).includes('other-session-input'), false);
    await runtime.run('source-after-fork', options('one'), writer('one'), context);
    assert.equal(bindings.get('one'), originalThread);
    assert.equal(requests[5].url, '/beta/responses');
    assert.equal(JSON.stringify(requests[5].body.input).includes('fork-only-input'), false);

    // Saving the global default affects only threads created afterwards: the
    // already-loaded alpha session stays on alpha and the process is not restarted.
    const processId = transport.status.pid;
    assert.ok(processId);
    const saved = await modelProviders.setDefault('beta');
    assert.equal(saved.defaultProvider, 'beta');
    await runtime.run('existing-session-keeps-alpha', options('two'), writer('two'), context);
    assert.equal(requests[6].url, '/alpha/responses');
    sessionsDb.createAppSession('three', 'codex', root);
    sessionRuntimeDb.update('three', { runtime: 'app-server' });
    await runtime.run('new-session-uses-saved-default', options('three'), writer('three'), context);
    assert.equal(requests[7].url, '/beta/responses');
    assert.equal(transport.status.pid, processId);
    assert.equal(bindings.get('one'), originalThread);
  } finally {
    finishFirst?.();
    await transport.close(); await runtime.close();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalGoals === undefined) delete process.env.CLOUDCLI_CODEX_GOAL_ENABLED; else process.env.CLOUDCLI_CODEX_GOAL_ENABLED = originalGoals;
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});
