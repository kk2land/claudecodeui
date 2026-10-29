import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionRuntimeDb, sessionsDb } from '@/modules/database/index.js';
import { CodexAppServerRuntime } from '@/modules/providers/list/codex/codex-app-server.runtime.js';
import { codexAppServerTransport, CodexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.transport.js';
import { CodexModelProviderService } from '@/modules/providers/list/codex/codex-model-provider.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/index.js';

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
  const require = createRequire(import.meta.url);
  // CI normally uses the package-pinned CLI. An explicit test-only binary lets
  // a developer validate that same release without replacing a local launcher.
  const binary = process.env.CLOUDCLI_CODEX_TEST_BINARY;
  const transport = new CodexAppServerTransport({ spawn: () => spawn(binary || process.execPath,
    [...(binary ? [] : [require.resolve('@openai/codex/bin/codex.js')]), 'app-server', '-c', 'thread_unload_delay_secs=0', '-c', 'features.goals=false'],
    { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_HOME: root } }), timeoutMs: 10_000 });
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
  const runtime = new CodexAppServerRuntime(transport, sessionRuntimeDb, 10_000, () => {}, async () => [], 30_000,
    { modelProviders: new CodexModelProviderService({ home: root, environment: {} }) });
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
    assert.equal(runtime.getState('one').diagnostics?.cliVersion, '0.163.0');
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
