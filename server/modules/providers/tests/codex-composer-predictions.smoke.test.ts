import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexAppServerRuntime } from '@/modules/providers/list/codex/codex-app-server.runtime.js';
import { CodexAppServerTransport } from '@/modules/providers/list/codex/codex-app-server.transport.js';
import { CodexModelProviderService } from '@/modules/providers/list/codex/codex-model-provider.service.js';
import type {
  AnyRecord,
  CodexPredictionConfigResult,
  CodexPredictionConfiguration,
  ProviderRuntimeContext,
  SessionRuntimeSettings,
} from '@/shared/index.js';

async function until(check: () => boolean | Promise<boolean>, description: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

const SUGGESTION = 'Write the regression test for this fix.';

const PREDICTION_CONFIG: CodexPredictionConfiguration = {
  isEnabled: true,
  unsupportedModels: [],
  sampleRate: 1,
  liveSampleRate: 1,
  prompt: 'Predict the user\'s next message.',
  promptVersion: 'smoke-v1',
  predictionReasoningEffort: null,
};

/**
 * End-to-end smoke over the real 0.163.0 binary with the production prediction
 * executor: a normal opted-in parent turn completes, the runtime forks an
 * ephemeral prediction thread, runs an ordinary turn seeded with the configured
 * prompt, parses the JSON suggestion from a localhost Responses stub, and
 * unloads the fork — no account, no paid model, no network beyond 127.0.0.1.
 */
test('real 0.163.0 app-server forks an ephemeral prediction, parses the JSON suggestion and unloads it', { timeout: 60_000 }, async (t) => {
  const require = createRequire(import.meta.url);
  let launcher: string;
  try { launcher = require.resolve('@openai/codex/bin/codex.js'); }
  catch { t.skip('The pinned Codex package is not installed.'); return; }
  if (process.platform === 'win32') { t.skip('The POSIX process probe is covered on macOS/Linux.'); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-pred-smoke-'));

  // A local Responses stub: the parent turn gets plain text; the prediction
  // turn gets a JSON suggestion. Every request is recorded so the assertions can
  // prove the prediction inherited the parent user+assistant context.
  const requests: AnyRecord[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (!request.url?.endsWith('/responses')) { response.writeHead(404); response.end(); return; }
      let text = '';
      for await (const chunk of request) text += chunk;
      const body = JSON.parse(text);
      requests.push(body);
      const serialized = JSON.stringify(body.input ?? []);
      const isPrediction = serialized.includes('Return only JSON matching this schema');
      const reply = isPrediction ? JSON.stringify({ suggestion: SUGGESTION }) : 'PARENT_REPLY';
      const item = { id: `message-${requests.length}`, type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: reply, annotations: [] }] };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (type: string, data: AnyRecord) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      // The prediction turn's usage is deliberately distinctive so a leak into
      // the parent budget is detectable.
      const usage = isPrediction
        ? { input_tokens: 9999, output_tokens: 9999, total_tokens: 19998 }
        : { input_tokens: 3, output_tokens: 1, total_tokens: 4 };
      emit('response.created', { response: { id: `response-${requests.length}` } });
      emit('response.output_item.added', { output_index: 0, item });
      emit('response.output_item.done', { output_index: 0, item });
      emit('response.completed', { response: { id: `response-${requests.length}`, status: 'completed', output: [item], usage } });
      response.end();
    } catch {
      try { response.writeHead(500); response.end(); } catch { /* already closed */ }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await writeFile(path.join(root, 'config.toml'), `model="gpt-5.4"\nmodel_provider="smoke"\n[model_providers.smoke]\nname="smoke"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);

  const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), CODEX_HOME: root };
  const transport = new CodexAppServerTransport({ spawn: () => spawn(process.execPath, [launcher, 'app-server', '-c', 'thread_unload_delay_secs=0'], {
    stdio: ['pipe', 'pipe', 'pipe'], env,
  }), timeoutMs: 5000 });

  // Record the real `thread/fork` acknowledgement (the fork id is not guessable
  // and a fork is not a subagent, so it has no parentThreadId).
  const nativeRequest = transport.request.bind(transport);
  let forkInfo: AnyRecord | null = null;
  transport.request = async <T = AnyRecord>(method: string, params?: unknown): Promise<T> => {
    const result = await nativeRequest<T>(method, params);
    if (method === 'thread/fork') forkInfo = (result as AnyRecord).thread;
    return result;
  };

  let settings: SessionRuntimeSettings = { runtime: 'app-server', mode: 'default', queueHeld: false };
  const settingsDb = {
    get: () => settings,
    update: (_: string, patch: Partial<SessionRuntimeSettings>) => settings = { ...settings, ...patch },
    holdCodexAppServerQueues: () => { if (settings.runtime === 'app-server') settings = { ...settings, queueHeld: true }; },
  };
  const configProvider = {
    load: () => Promise.resolve({ status: 'ready', config: PREDICTION_CONFIG } as CodexPredictionConfigResult),
  };
  // Production executor (default), injected config and a test-only eligibility
  // gate so the local smoke model passes; production still accepts only `openai`.
  const runtime = new CodexAppServerRuntime(transport, settingsDb, 5_000, () => {}, async () => [], 30_000, {
    configProvider,
    providerEligible: () => true,
    modelProviders: new CodexModelProviderService({ home: root, environment: {} }),
  });

  let threadId: string | null = null;
  const events: AnyRecord[] = [];
  const writer = { send: (event: unknown) => events.push(event as AnyRecord), setSessionId: (id: string) => { threadId = id; }, nextTurn: () => writer };
  const context: ProviderRuntimeContext = { resolveProviderSessionId: () => threadId, resolveResumeModel: async () => 'gpt-5.4',
    normalizeMessage: () => [], getProviderModels: async () => ({ DEFAULT: 'gpt-5.4', OPTIONS: [] }), isProviderInstalled: async () => true };
  const options = { sessionId: 'app-pred-smoke', cwd: root, permissionMode: 'bypassPermissions', composerPredictions: true };

  try {
    const running = runtime.run('Parent smoke prompt.', options, writer, context);
    // Attach a rejection handler immediately, then let the parent turn complete.
    const parentDone = running.then(() => 'done' as const, (error: Error) => ({ error } as const));
    let parentError: Error | null = null;
    { const settled = await parentDone; if (settled !== 'done') parentError = settled.error; }
    assert.equal(parentError, null, `parent turn failed: ${parentError?.message ?? ''}`);

    // Wait until the prediction leaves `pending`; report immediately if it fails.
    await until(() => {
      const status = runtime.getState('app-pred-smoke').prediction?.status;
      return status === 'ready' || status === 'unavailable';
    }, 'prediction to settle');
    const prediction = runtime.getState('app-pred-smoke').prediction;
    assert.equal(prediction?.status, 'ready', `prediction unavailable: ${JSON.stringify({ prediction, requests: requests.length })}`);
    assert.equal(prediction?.text, SUGGESTION, 'parsed JSON suggestion');

    // The runtime recognized the real 0.163.0 binary and enabled the protocol.
    const state = runtime.getState('app-pred-smoke');
    assert.equal(state.diagnostics?.cliVersion, '0.163.0');
    assert.equal(state.predictionSupported, true);

    // Exactly two model requests: the parent turn and one prediction turn.
    assert.equal(requests.length, 2, 'one parent and one prediction model request');
    const predictionRequest = requests[1];
    const predictionJson = JSON.stringify(predictionRequest.input ?? []);
    // The prediction inherited the parent user + assistant context and carried
    // the remote prompt plus the JSON schema instruction.
    assert.ok(predictionJson.includes('Parent smoke prompt.'), 'prediction input inherits the parent user message');
    assert.ok(predictionJson.includes('PARENT_REPLY'), 'prediction input inherits the parent assistant reply');
    assert.ok(predictionJson.includes(PREDICTION_CONFIG.prompt), 'prediction input carries the configured prompt');
    assert.ok(predictionJson.includes('Return only JSON matching this schema'), 'prediction input carries the JSON schema instruction');

    // The fork was ephemeral, is a distinct thread and wrote no transcript.
    const fork = forkInfo as AnyRecord | null;
    assert.ok(fork, 'thread/fork acknowledged a fork');
    assert.notEqual(fork.id, threadId);
    assert.equal(fork.ephemeral, true);
    assert.equal(fork.path ?? null, null);

    // The parent thread and its rollout on disk never contain the prediction.
    const snapshot = await transport.request('thread/read', { threadId, includeTurns: true }) as AnyRecord;
    const parentJson = JSON.stringify(snapshot);
    assert.ok(!parentJson.includes(SUGGESTION), 'parent thread must not contain the prediction suggestion');
    assert.ok(!parentJson.includes(PREDICTION_CONFIG.prompt), 'parent thread must not contain the prediction prompt');
    const rollout = await readFile(snapshot.thread.path as string, 'utf8');
    assert.ok(rollout.includes('Parent smoke prompt.'), 'parent rollout holds the parent prompt');
    assert.ok(rollout.includes('PARENT_REPLY'), 'parent rollout holds the parent reply');
    assert.ok(!rollout.includes(SUGGESTION), 'parent rollout must not contain the suggestion');
    assert.ok(!rollout.includes(PREDICTION_CONFIG.prompt), 'parent rollout must not contain the prediction prompt');

    // The parent writer saw exactly one completion and one session_created, and
    // no prediction text, budget or child.
    assert.equal(events.filter((e) => e.kind === 'complete').length, 1, 'exactly one parent completion');
    assert.equal(events.filter((e) => e.kind === 'session_created').length, 1, 'exactly one session_created');
    assert.equal(events.some((e) => e.kind !== 'status' && JSON.stringify(e).includes(SUGGESTION)), false, 'prediction text must not reach the parent');
    assert.equal(events.every((e) => !e.tokenBudget || e.tokenBudget.used < 9999), true, 'prediction usage must not reach the parent budget');
    assert.equal(events.some((e) => e.kind === 'subagent' || e.kind === 'subagent_started'), false, 'prediction must not be a user subagent');

    // No persistent fork session: thread/list holds only the parent.
    const threadList = await transport.request('thread/list', { limit: 100 }) as AnyRecord;
    const listedIds = (threadList.data ?? threadList.threads ?? []).map((entry: AnyRecord) => entry.id ?? entry.thread?.id);
    assert.ok(listedIds.includes(threadId), 'parent thread is listed');
    assert.ok(!listedIds.includes(fork.id), 'fork thread is not a persistent session');

    // The fork was fully unloaded, leaving only the parent loaded.
    await until(async () => {
      const loaded = await transport.request('thread/loaded/list', {}) as AnyRecord;
      return Array.isArray(loaded.data) && loaded.data.length === 1 && loaded.data[0] === threadId;
    }, 'fork unloaded leaving only the parent', 15_000);
  } finally {
    await runtime.abort('app-pred-smoke').catch(() => false);
    await transport.close(); await runtime.close();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
